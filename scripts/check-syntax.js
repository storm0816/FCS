const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['server.js', 'public/app.js', 'src/config.js', 'src/database.js', 'src/agentService.js', 'src/dashboardService.js', 'src/ldap.js', 'src/objectStorage.js'];
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`缺少文件：${file}`);
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`语法检查通过：${files.length} 个核心文件`);
