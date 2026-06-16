@echo off
chcp 65001 >nul
cd /d C:\Users\Administrator\hamdean2

echo === Clean plain/crypto backups ===
del /q /s "C:\Users\Administrator\hamdean2\*.plain.bak" 2>nul
del /q /s "C:\Users\Administrator\hamdean2\*.crypto.bak" 2>nul
del /q /s "C:\Users\Administrator\hamdean2\*.bak2" 2>nul
del /q /s "C:\Users\Administrator\hamdean2\*.bak3" 2>nul
del /q "C:\Users\Administrator\stock-tracker\*.plain.bak" 2>nul
del /q "C:\Users\Administrator\claude-dispatcher\*.plain.bak" 2>nul

echo === Git add and commit ===
git add -A
git commit -m "v4.0.2: AES-256-GCM encrypted storage + exec + precise time"

echo === Tag and push ===
git tag v4.0.2
git push origin main --tags

echo === Build installer ===
npm run build

echo === Done ===
dir dist\*.exe
