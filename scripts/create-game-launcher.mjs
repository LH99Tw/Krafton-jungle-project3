import fs from "fs";
import path from "path";

const desktopPath = "C:/Users/lizar/OneDrive/바탕 화면";
const repoPath = "C:/Users/lizar/OneDrive/문서/GitHub/Krafton-jungle-project3";

const batGameContent = `@echo off
chcp 65001 > NUL
title 🎮 5 Days to Demon King 게임 실행기
echo ===================================================
echo 🎮 5 Days to Demon King 게임을 바로 실행하는 중입니다...
echo ===================================================

netstat -ano | findstr :3000 > NUL
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] 게임 서버가 실행 중이지 않습니다. 개발 서버를 자동 가동합니다...
    start /min "FiveDaysDevServer" cmd /c "cd /d "${repoPath}" && pnpm dev"
    timeout /t 5 > NUL
)

echo [INFO] 웹 브라우저에서 게임을 실행합니다...
start http://localhost:3000/?heroClass=mage
exit
`;

const gameUrlContent = `[InternetShortcut]
URL=http://localhost:3000/?heroClass=mage
IconIndex=0
`;

try {
  fs.writeFileSync(path.join(desktopPath, "🎮 게임_바로실행.bat"), batGameContent, "utf8");
  fs.writeFileSync(path.join(desktopPath, "🎮 게임_바로가기.url"), gameUrlContent, "utf8");
  fs.writeFileSync(path.join(desktopPath, "Run_Game.bat"), batGameContent, "utf8");
  console.log("Successfully created game launcher executable!");
} catch (err) {
  console.error("Error creating game launcher:", err);
}