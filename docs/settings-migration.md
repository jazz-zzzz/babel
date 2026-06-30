# 从原版 Babel 迁移设置

## 导出设置

在原版扩展的设置页面 Console 中运行：

```js
// 导出所有设置到文件
chrome.storage.local.get(null).then(d => {
  const json = JSON.stringify(d, null, 2);
  const blob = new Blob([json], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'babel-settings-backup.json';
  a.click();
});
```

## 导入设置到 babel

1. 将备份文件放到项目根目录
2. 在项目目录起一个 HTTP 服务：

```bash
npx serve . -p 3456
```

3. 打开 babel 设置页面（右键图标 → 选项）
4. F12 → Console，运行：

```js
// 先清空
await chrome.storage.local.clear();

// 从本地服务器拉取并导入
fetch('http://localhost:3456/babel-settings-backup.json')
  .then(r => r.json())
  .then(async d => {
    for (const [k, v] of Object.entries(d)) {
      await chrome.storage.local.set({ [k]: v });
      console.log('✅', k);
    }
    console.log('🎉 完成！刷新页面');
  });
```

5. 停止 HTTP 服务（`Ctrl+C`）

## 注意事项

- 存储的值保持原始格式，不要 `JSON.parse`，否则扩展会报 `parse json in storage err`
- 导入完成后立即生效，无需重启扩展
