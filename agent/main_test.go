package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPackageAndExtractKeepsDirectoryContents(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "home", "MobileServer", "DATA", "SH", "history", "day")
	if err := os.MkdirAll(filepath.Join(source, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "600000.NIG"), []byte("market-data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "ignored.txt"), []byte("ignore"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "600001.NIG"), []byte("nested-data"), 0o644); err != nil {
		t.Fatal(err)
	}

	archive := filepath.Join(root, "release.tar.gz")
	if err := packageFiles(source, "*.NIG", archive); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(root, "stage")
	if err := extractArchive(archive, stage); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"600000.NIG", filepath.Join("nested", "600001.NIG")} {
		if _, err := os.Stat(filepath.Join(stage, name)); err != nil {
			t.Fatalf("解压后缺少 %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(stage, "ignored.txt")); !os.IsNotExist(err) {
		t.Fatal("非匹配文件不应进入发布包")
	}
}

func TestAutomaticAgentIDStable(t *testing.T) {
	first := automaticAgentID("10.37.0.23")
	second := automaticAgentID("10.37.0.23")
	if first == "" || first != second {
		t.Fatalf("Agent ID 应稳定且非空: %q / %q", first, second)
	}
}

func TestBuildHashFileHonorsGenericDatasetRules(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "nested", "skip"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"one.NIG": "one", "two.txt": "two", "nested/three.NIG": "three", "nested/skip/four.NIG": "four",
	} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	content, err := buildHashFile(MarketConfig{
		DataDir: root, FilePatterns: "*.NIG,*.txt", ExcludePatterns: "nested/skip/*", Recursive: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"one.NIG", "two.txt", "nested/three.NIG"} {
		if !strings.Contains(content, expected) {
			t.Fatalf("expected %s in manifest: %s", expected, content)
		}
	}
	if strings.Contains(content, "four.NIG") {
		t.Fatalf("excluded file present: %s", content)
	}

	nonRecursive, err := buildHashFile(MarketConfig{DataDir: root, FilePatterns: "*.NIG"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(nonRecursive, "one.NIG") || strings.Contains(nonRecursive, "three.NIG") {
		t.Fatalf("non-recursive scan incorrect: %s", nonRecursive)
	}
}

func TestDataDirectoryPreflight(t *testing.T) {
	root := t.TempDir()
	if err := checkSourceDirectory(root); err != nil {
		t.Fatal(err)
	}
	if err := checkTargetDirectory(filepath.Join(root, "target")); err != nil {
		t.Fatal(err)
	}
	if err := checkSourceDirectory(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing source should fail")
	}
	if err := checkTargetDirectory(filepath.Join(root, "missing", "target")); err == nil {
		t.Fatal("missing target parent should fail")
	}
}
