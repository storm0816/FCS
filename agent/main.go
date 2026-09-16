package main

import (
	"archive/tar"
	"bytes"
	"context"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/blake2b"
)

type Config struct {
	MasterURL        string `json:"masterUrl"`
	AgentID          string `json:"-"`
	Zone             string `json:"zone"`
	InnerIP          string `json:"innerIp"`
	OuterIP          string `json:"outerIp"`
	HeartbeatSeconds int    `json:"heartbeatSeconds"`
}
type MarketConfig struct {
	Code            string `json:"code"`
	DataDir         string `json:"dataDir"`
	FilePattern     string `json:"filePattern"`
	FilePatterns    string `json:"filePatterns"`
	ExcludePatterns string `json:"excludePatterns"`
	Recursive       bool   `json:"recursive"`
	FollowSymlinks  bool   `json:"followSymlinks"`
}
type Task struct {
	TaskID        string         `json:"taskId"`
	MarketConfigs []MarketConfig `json:"marketConfigs"`
}
type HeartbeatResponse struct {
	Online   bool      `json:"online"`
	Task     *Task     `json:"task"`
	DataTask *DataTask `json:"dataTask"`
}
type DataTask struct {
	TaskID      string `json:"taskId"`
	ReleaseID   string `json:"releaseId"`
	Action      string `json:"action"`
	DataDir     string `json:"dataDir"`
	FilePattern string `json:"filePattern"`
	DownloadURL string `json:"downloadUrl"`
	TosURI      string `json:"tosUri"`
	SHA256      string `json:"sha256"`
	SizeBytes   int64  `json:"sizeBytes"`
}
type HashReport struct {
	Market      string `json:"market"`
	HashContent string `json:"hashContent"`
}

func main() {
	configPath := flag.String("config", "agent.json", "Agent config path")
	flag.Parse()
	var cfg Config
	raw, err := os.ReadFile(*configPath)
	if err != nil {
		fatal(err)
	}
	if err = json.Unmarshal(raw, &cfg); err != nil {
		fatal(err)
	}
	if cfg.MasterURL == "" {
		fatal(fmt.Errorf("masterUrl 为必填项"))
	}
	if cfg.HeartbeatSeconds < 2 {
		cfg.HeartbeatSeconds = 10
	}
	if cfg.InnerIP == "" {
		cfg.InnerIP = localIP()
	}
	if cfg.OuterIP == "" {
		cfg.OuterIP = publicIP()
	}
	cfg.AgentID = automaticAgentID(cfg.InnerIP)
	host, _ := os.Hostname()
	// 发布与下载可能持续数小时，任务层用心跳与状态管理，不使用 HTTP 固定超时中断大文件传输。
	client := &http.Client{Timeout: 0}
	taskQueue := make(chan HeartbeatResponse, 64)
	go func() {
		for reply := range taskQueue {
			handleTaskReply(client, &cfg, reply)
		}
	}()
	for {
		payload := map[string]string{"agentId": cfg.AgentID, "hostname": host, "innerIp": cfg.InnerIP, "outerIp": cfg.OuterIP, "zone": cfg.Zone, "agentVersion": "0.2.2"}
		var reply HeartbeatResponse
		if err := postJSON(client, strings.TrimRight(cfg.MasterURL, "/")+"/api/agent/heartbeat", payload, &reply); err != nil {
			logf("心跳失败: %v", err)
		} else if reply.DataTask != nil || reply.Task != nil {
			taskQueue <- reply
		}
		time.Sleep(time.Duration(cfg.HeartbeatSeconds) * time.Second)
	}
}

func handleTaskReply(client *http.Client, cfg *Config, reply HeartbeatResponse) {
	if reply.DataTask != nil {
		if err := runDataTaskTos(client, cfg.MasterURL, reply.DataTask); err != nil {
			logf("数据任务失败: %v", err)
			_ = postJSON(client, strings.TrimRight(cfg.MasterURL, "/")+"/api/data/tasks/"+reply.DataTask.TaskID+"/report", map[string]interface{}{"ok": false, "detail": map[string]interface{}{"message": err.Error()}}, &map[string]interface{}{})
		}
		return
	}
	if reply.Task == nil {
		return
	}
	logf("收到巡检任务 %s", reply.Task.TaskID)
	reports := make([]HashReport, 0, len(reply.Task.MarketConfigs))
	failures := make([]string, 0)
	for _, market := range reply.Task.MarketConfigs {
		content, err := buildHashFile(market)
		if err != nil {
			logf("市场 %s 哈希失败: %v", market.Code, err)
			failures = append(failures, fmt.Sprintf("%s: %v", market.Code, err))
			continue
		}
		reports = append(reports, HashReport{Market: market.Code, HashContent: content})
	}
	body := map[string]interface{}{"taskId": reply.Task.TaskID, "agentId": cfg.AgentID, "reports": reports}
	if len(failures) > 0 {
		body["error"] = strings.Join(failures, "; ")
	}
	var ignored interface{}
	if err := postJSON(client, strings.TrimRight(cfg.MasterURL, "/")+"/api/agent/report", body, &ignored); err != nil {
		logf("任务上报失败: %v", err)
	} else {
		logf("任务 %s 上报完成", reply.Task.TaskID)
	}
}

func runTosutil(args ...string) error {
	cmd := exec.Command("tosutil", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("tosutil failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// Run tosutil with a lightweight cancellation watcher. The Master marks the
// task cancelled; polling lets a long transfer terminate without waiting for
// the next heartbeat.
func runTosutilCancelable(client *http.Client, master, taskID string, args ...string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	statusClient := &http.Client{Timeout: 5 * time.Second}
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done(): return
			case <-ticker.C:
				res, err := statusClient.Get(strings.TrimRight(master, "/") + "/api/data/tasks/" + taskID + "/status")
				if err != nil { continue }
				var status struct{ Status string `json:"status"` }
				_ = json.NewDecoder(res.Body).Decode(&status); _ = res.Body.Close()
				if status.Status == "cancelled" { cancelled <- struct{}{}; cancel(); return }
			}
		}
	}()
	cmd := exec.CommandContext(ctx, "tosutil", args...)
	out, err := cmd.CombinedOutput()
	cancel()
	<-done
	wasCancelled := false
	select { case <-cancelled: wasCancelled = true; default: }
	if wasCancelled {
		return fmt.Errorf("任务已取消")
	}
	if err != nil { return fmt.Errorf("tosutil failed: %s: %w", strings.TrimSpace(string(out)), err) }
	return nil
}

func fileSHA256(name string) (string, int64, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func runDataTaskTos(client *http.Client, master string, task *DataTask) error {
	_ = postJSON(client, strings.TrimRight(master, "/")+"/api/data/tasks/"+task.TaskID+"/progress", map[string]interface{}{"status": "processing", "detail": map[string]interface{}{"message": task.Action}}, &map[string]interface{}{})
	checkpointDir := filepath.Join(os.TempDir(), "fcs-agent-checkpoints")
	if err := os.MkdirAll(checkpointDir, 0o700); err != nil {
		return fmt.Errorf("create checkpoint directory: %w", err)
	}
	if task.Action == "download" {
		return downloadAndReplaceTos(client, master, task, checkpointDir)
	}
	if task.Action != "publish" {
		return fmt.Errorf("unknown data task %s", task.Action)
	}
	if task.TosURI == "" || !filepath.IsAbs(task.DataDir) {
		return fmt.Errorf("TOS URI 为空或行情目录不是绝对路径")
	}
	if err := checkSourceDirectory(task.DataDir); err != nil {
		return err
	}
	tmpPath := filepath.Join(os.TempDir(), "fcs-agent-checkpoints", task.TaskID+".tar.gz")
	readyPath := tmpPath + ".ready"
	if err := os.MkdirAll(filepath.Dir(tmpPath), 0o700); err != nil { return err }
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil { return err }
	tmp.Close()
	packageStarted := time.Now()
	if _, readyErr := os.Stat(readyPath); readyErr != nil {
		if err = packageFiles(task.DataDir, task.FilePattern, tmpPath); err != nil { return err }
		if err = os.WriteFile(readyPath, []byte("ready"), 0o600); err != nil { return err }
	}
	packageMs := time.Since(packageStarted).Milliseconds()
	uploadStarted := time.Now()
	if err = runTosutilCancelable(client, master, task.TaskID, "cp", tmpPath, task.TosURI, "-cpd="+checkpointDir); err != nil {
		return err
	}
	uploadMs := time.Since(uploadStarted).Milliseconds()
	sha, size, err := fileSHA256(tmpPath)
	if err != nil {
		return err
	}
	err = postJSON(client, strings.TrimRight(master, "/")+"/api/data/tasks/"+task.TaskID+"/report", map[string]interface{}{"ok": true, "sha256": sha, "sizeBytes": size, "detail": map[string]interface{}{"message": "tosutil upload completed with checkpoint", "packageMs": packageMs, "uploadMs": uploadMs}}, &map[string]interface{}{})
	if err == nil { _ = os.Remove(tmpPath); _ = os.Remove(readyPath) }
	return err
}

func downloadAndReplaceTos(client *http.Client, master string, task *DataTask, checkpointDir string) error {
	if task.DataDir == "" || task.TosURI == "" || !filepath.IsAbs(task.DataDir) {
		return fmt.Errorf("行情目录、TOS URI 缺失或行情目录不是绝对路径")
	}
	if err := checkTargetDirectory(task.DataDir); err != nil {
		return err
	}
	unlock, err := acquireSyncLock(task.DataDir)
	if err != nil {
		return err
	}
	defer unlock()
	if err := checkDownloadSpace(task.DataDir, task.SizeBytes); err != nil {
		return err
	}
	tmpPath := filepath.Join(os.TempDir(), "fcs-agent-checkpoints", task.TaskID+"-download.tar.gz")
	if err := os.MkdirAll(filepath.Dir(tmpPath), 0o700); err != nil { return err }
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil { return err }
	tmp.Close()
	downloadStarted := time.Now()
	if err = runTosutilCancelable(client, master, task.TaskID, "cp", task.TosURI, tmpPath, "-cpd="+checkpointDir); err != nil {
		return err
	}
	downloadMs := time.Since(downloadStarted).Milliseconds()
	verifyStarted := time.Now()
	hash, _, err := fileSHA256(tmpPath)
	if err != nil {
		return err
	}
	if task.SHA256 != "" && hash != task.SHA256 {
		return fmt.Errorf("SHA-256 mismatch")
	}
	verifyMs := time.Since(verifyStarted).Milliseconds()
	replaceStarted := time.Now()
	stage := task.DataDir + ".fcs-stage"
	backup := task.DataDir + ".fcs-backup"
	os.RemoveAll(stage)
	if err = extractArchive(tmpPath, stage); err != nil {
		return err
	}
	os.RemoveAll(backup)
	if _, statErr := os.Stat(task.DataDir); statErr == nil {
		if err = os.Rename(task.DataDir, backup); err != nil {
			return err
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	if err = os.Rename(stage, task.DataDir); err != nil {
		os.Rename(backup, task.DataDir)
		return err
	}
	os.RemoveAll(backup)
	replaceMs := time.Since(replaceStarted).Milliseconds()
	err = postJSON(client, strings.TrimRight(master, "/")+"/api/data/tasks/"+task.TaskID+"/report", map[string]interface{}{"ok": true, "detail": map[string]interface{}{"message": "tosutil download, checksum and atomic replace completed with checkpoint", "downloadMs": downloadMs, "verifyMs": verifyMs, "replaceMs": replaceMs}}, &map[string]interface{}{})
	if err == nil { _ = os.Remove(tmpPath) }
	return err
}

// Preflight checks fail before any download, extraction or rename. They keep a
// bad per-Agent binding from turning into a partial replacement operation.
func checkSourceDirectory(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("source directory unavailable: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("source path is not a directory: %s", dir)
	}
	return nil
}

func checkTargetDirectory(dir string) error {
	parent := filepath.Dir(dir)
	info, err := os.Stat(parent)
	if err != nil {
		return fmt.Errorf("target parent unavailable: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("target parent is not a directory: %s", parent)
	}
	probe, err := os.CreateTemp(parent, ".fcs-writecheck-")
	if err != nil {
		return fmt.Errorf("target parent is not writable: %w", err)
	}
	name := probe.Name()
	closeErr := probe.Close()
	removeErr := os.Remove(name)
	if closeErr != nil {
		return closeErr
	}
	return removeErr
}

// A per-directory lock prevents two queued releases from replacing the same
// target concurrently. It is removed automatically after success or failure.
func acquireSyncLock(dir string) (func(), error) {
	lock := dir + ".fcs-sync.lock"
	f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		if os.IsExist(err) {
			return nil, fmt.Errorf("another sync is already running for: %s", dir)
		}
		return nil, err
	}
	_, _ = f.WriteString(fmt.Sprintf("pid=%d started=%s\n", os.Getpid(), time.Now().Format(time.RFC3339)))
	_ = f.Close()
	return func() { _ = os.Remove(lock) }, nil
}

// The release archive must coexist with the staged replacement and backup.
// The calculation is deliberately conservative enough to fail before writes;
// it does not claim to predict an archive's uncompressed size exactly.
func checkDownloadSpace(dir string, archiveBytes int64) error {
	if archiveBytes <= 0 {
		return nil
	}
	free, err := availableDiskSpace(filepath.Dir(dir))
	if err != nil {
		return fmt.Errorf("cannot check free space: %w", err)
	}
	required := archiveBytes*2 + 128*1024*1024
	if existing, err := directorySize(dir); err == nil {
		required += existing
	}
	if free < required {
		return fmt.Errorf("insufficient free space: available=%d required-at-least=%d", free, required)
	}
	return nil
}

func directorySize(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	if os.IsNotExist(err) {
		return 0, nil
	}
	return total, err
}

func runDataTask(client *http.Client, master string, task *DataTask) error {
	if task.Action == "download" {
		return downloadAndReplace(client, master, task)
	}
	if task.Action != "publish" {
		return fmt.Errorf("未知数据任务 %s", task.Action)
	}
	tmp, err := os.CreateTemp("", "fcs-release-*.tar.gz")
	if err != nil {
		return err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	if err = packageFiles(task.DataDir, task.FilePattern, tmp.Name()); err != nil {
		return err
	}
	f, err := os.Open(tmp.Name())
	if err != nil {
		return err
	}
	defer f.Close()
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(master, "/")+"/api/data/releases/"+task.ReleaseID+"/upload", f)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/gzip")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		b, _ := io.ReadAll(res.Body)
		return fmt.Errorf("上传失败: %s", b)
	}
	return postJSON(client, strings.TrimRight(master, "/")+"/api/data/tasks/"+task.TaskID+"/report", map[string]interface{}{"ok": true, "detail": "已打包并上传 TOS"}, &map[string]interface{}{})
}
func downloadAndReplace(client *http.Client, master string, task *DataTask) error {
	if task.DataDir == "" || task.DownloadURL == "" {
		return fmt.Errorf("下载任务缺少行情目录或下载地址")
	}
	tmp, err := os.CreateTemp("", "fcs-download-*.tar.gz")
	if err != nil {
		return err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	res, err := client.Get(strings.TrimRight(master, "/") + task.DownloadURL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("下载失败: %s", res.Status)
	}
	f, err := os.Create(tmp.Name())
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), res.Body)
	f.Close()
	if err != nil {
		return err
	}
	if task.SHA256 != "" && hex.EncodeToString(h.Sum(nil)) != task.SHA256 {
		return fmt.Errorf("SHA-256 校验失败")
	}
	stage := task.DataDir + ".fcs-stage"
	backup := task.DataDir + ".fcs-backup"
	os.RemoveAll(stage)
	if err = extractArchive(tmp.Name(), stage); err != nil {
		return err
	}
	os.RemoveAll(backup)
	if err = os.Rename(task.DataDir, backup); err != nil {
		return err
	}
	if err = os.Rename(stage, task.DataDir); err != nil {
		os.Rename(backup, task.DataDir)
		return err
	}
	os.RemoveAll(backup)
	return postJSON(client, strings.TrimRight(master, "/")+"/api/data/tasks/"+task.TaskID+"/report", map[string]interface{}{"ok": true, "detail": "已下载、校验并原子替换"}, &map[string]interface{}{})
}
func extractArchive(src, dest string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(h.Name)
		if filepath.IsAbs(name) || strings.HasPrefix(name, "..") {
			return fmt.Errorf("非法压缩包路径")
		}
		p := filepath.Join(dest, name)
		if h.Typeflag == tar.TypeDir {
			if err = os.MkdirAll(p, 0755); err != nil {
				return err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			return err
		}
		o, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode))
		if err != nil {
			return err
		}
		_, err = io.Copy(o, tr)
		o.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
func packageFiles(dir, pattern, dest string) error {
	if pattern == "" {
		pattern = "*.NIG"
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	gz := gzip.NewWriter(out)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	err = filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		ok, _ := filepath.Match(pattern, entry.Name())
		if !ok {
			return nil
		}
		rel, e := filepath.Rel(dir, path)
		if e != nil {
			return e
		}
		h, e := tar.FileInfoHeader(info, "")
		if e != nil {
			return e
		}
		h.Name = filepath.ToSlash(rel)
		if e = tw.WriteHeader(h); e != nil {
			return e
		}
		f, e := os.Open(path)
		if e != nil {
			return e
		}
		_, copyErr := io.Copy(tw, f)
		closeErr := f.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	return err
}

// buildHashFile 等价 b2sum.sh：只扫描当前目录，按文件名排序，输出 BLAKE2b-512 与文件名。
func buildHashFile(config MarketConfig) (string, error) {
	dir := config.DataDir
	if dir == "" {
		return "", fmt.Errorf("未配置行情目录")
	}
	patterns := splitPatterns(config.FilePatterns)
	if len(patterns) == 0 {
		patterns = splitPatterns(config.FilePattern)
	}
	if len(patterns) == 0 {
		patterns = []string{"*.NIG"}
	}
	excludes := splitPatterns(config.ExcludePatterns)
	names := make([]string, 0)
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == dir {
			return nil
		}
		if entry.IsDir() {
			if !config.Recursive {
				return filepath.SkipDir
			}
			return nil
		}
		isLink := entry.Type()&os.ModeSymlink != 0
		if isLink && !config.FollowSymlinks {
			return nil
		}
		info, infoErr := entry.Info()
		if isLink && config.FollowSymlinks {
			info, infoErr = os.Stat(path)
		}
		if infoErr != nil {
			return infoErr
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		if matchesPattern(rel, excludes) || !matchesPattern(rel, patterns) {
			return nil
		}
		names = append(names, rel)
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(names)
	var out strings.Builder
	for _, name := range names {
		f, err := os.Open(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return "", err
		}
		hash, err := blake2b.New512(nil)
		if err == nil {
			_, err = io.Copy(hash, f)
		}
		f.Close()
		if err != nil {
			return "", err
		}
		out.WriteString(hex.EncodeToString(hash.Sum(nil)))
		out.WriteString("  ")
		out.WriteString(name)
		out.WriteByte('\n')
	}
	return out.String(), nil
}

func splitPatterns(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ';' || r == '\n' || r == '\r' })
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			result = append(result, filepath.ToSlash(value))
		}
	}
	return result
}

func matchesPattern(rel string, patterns []string) bool {
	base := filepath.Base(rel)
	for _, pattern := range patterns {
		if ok, _ := filepath.Match(pattern, rel); ok {
			return true
		}
		if ok, _ := filepath.Match(pattern, base); ok {
			return true
		}
	}
	return false
}

func postJSON(client *http.Client, url string, payload interface{}, target interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	res, err := client.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		b, _ := io.ReadAll(res.Body)
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, string(b))
	}
	return json.NewDecoder(res.Body).Decode(target)
}
func localIP() string {
	ifaces, _ := net.Interfaces()
	for _, i := range ifaces {
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ip, _, _ := net.ParseCIDR(a.String())
			if ip != nil && ip.To4() != nil && !ip.IsLoopback() {
				return ip.String()
			}
		}
	}
	return "127.0.0.1"
}

func automaticAgentID(innerIP string) string {
	interfaces, _ := net.Interfaces()
	mac := ""
	for _, iface := range interfaces {
		if len(iface.HardwareAddr) == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := iface.Addrs()
		for _, address := range addresses {
			ip, _, _ := net.ParseCIDR(address.String())
			if ip != nil && ip.String() == innerIP {
				mac = iface.HardwareAddr.String()
				break
			}
		}
		if mac != "" {
			break
		}
	}
	if mac == "" {
		for _, iface := range interfaces {
			if len(iface.HardwareAddr) > 0 && iface.Flags&net.FlagLoopback == 0 {
				mac = iface.HardwareAddr.String()
				break
			}
		}
	}
	mac = strings.ReplaceAll(strings.ToLower(mac), ":", "")
	ip := strings.NewReplacer(".", "-", ":", "-").Replace(innerIP)
	if mac == "" {
		return "agent-" + ip
	}
	return "agent-" + mac + "-" + ip
}

// publicIP 等价 curl ip.sb。网络不可用时返回空字符串，不影响心跳与巡检。
func publicIP() string {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.ip.sb/ip")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 128))
	if err != nil {
		return ""
	}
	ip := strings.TrimSpace(string(data))
	if net.ParseIP(ip) == nil {
		return ""
	}
	return ip
}
func logf(format string, args ...interface{}) {
	fmt.Printf("%s "+format+"\n", append([]interface{}{time.Now().Format("2006-01-02 15:04:05")}, args...)...)
}
func fatal(err error) { fmt.Fprintln(os.Stderr, "fcs-agent:", err); os.Exit(1) }

var _ = sha256.Size
