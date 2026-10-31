const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  const cssPath = path.join(__dirname, '..', 'dist', 'assets', 'index-J1705Jhw.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  await win.loadURL('about:blank');
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(css)};
      document.head.appendChild(style);

      const parent = document.createElement('div');
      parent.className = 'group';
      const child = document.createElement('span');
      child.className = 'group-hover:bg-primary/10 group-hover:text-primary';
      parent.appendChild(child);
      document.body.appendChild(parent);

      // Force hover state simulation or class
      // Let's check matching rules
      const normalBg = window.getComputedStyle(child).backgroundColor;

      // Now let's test the rule matching directly
      return {
        hasVarPrimary: window.getComputedStyle(document.documentElement).getPropertyValue('--primary'),
        hasVarPrimaryRgb: window.getComputedStyle(document.documentElement).getPropertyValue('--primary-rgb'),
        normalBg,
      };
    })()
  `);

  fs.writeFileSync('electron/test-hover.json', JSON.stringify(result, null, 2));
  app.quit();
});
