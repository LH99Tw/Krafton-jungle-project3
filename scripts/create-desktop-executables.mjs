import fs from "fs";
import path from "path";

const desktopPath = "C:/Users/lizar/OneDrive/바탕 화면";
const repoPath = "C:/Users/lizar/OneDrive/문서/GitHub/Krafton-jungle-project3";

const labBatContent = `@echo off
chcp 65001 > NUL
title 🧪 증강 밸런스 실험실 실행기
echo ===================================================
echo 🧪 증강 밸런스 실험실을 실행하는 중입니다...
echo ===================================================

netstat -ano | findstr :3000 > NUL
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] 게임 개발 서버가 실행 중이지 않습니다. 서버를 가동합니다...
    start /min "FiveDaysDevServer" cmd /c "cd /d "${repoPath}" && pnpm dev"
    timeout /t 5 > NUL
)

echo [INFO] 웹 브라우저에서 실험실을 엽니다...
start http://localhost:3000/?lab=1
exit
`;

const mageBatContent = `@echo off
chcp 65001 > NUL
title 🧙 마법사 게임 바로 시작하기
echo ===================================================
echo 🧙 5 Days to Demon King - 마법사 게임을 바로 실행합니다...
echo ===================================================

netstat -ano | findstr :3000 > NUL
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] 게임 개발 서버가 실행 중이지 않습니다. 서버를 가동합니다...
    start /min "FiveDaysDevServer" cmd /c "cd /d "${repoPath}" && pnpm dev"
    timeout /t 5 > NUL
)

echo [INFO] 웹 브라우저에서 마법사 게임을 엽니다...
start http://localhost:3000/?heroClass=mage
exit
`;

const labUrlContent = `[InternetShortcut]
URL=http://localhost:3000/?lab=1
IconIndex=0
`;

const mageUrlContent = `[InternetShortcut]
URL=http://localhost:3000/?heroClass=mage
IconIndex=0
`;

try {
  fs.writeFileSync(path.join(desktopPath, "🧪 증강실험실_실행.bat"), labBatContent, "utf8");
  fs.writeFileSync(path.join(desktopPath, "🧙 마법사게임_실행.bat"), mageBatContent, "utf8");
  fs.writeFileSync(path.join(desktopPath, "🧪 증강실험실_바로가기.url"), labUrlContent, "utf8");
  fs.writeFileSync(path.join(desktopPath, "🧙 마법사게임_바로가기.url"), mageUrlContent, "utf8");
  fs.writeFileSync(path.join(desktopPath, "Run_Augment_Lab.bat"), labBatContent, "utf8");
  fs.writeFileSync(path.join(desktopPath, "Run_Mage_Game.bat"), mageBatContent, "utf8");
  console.log("Successfully created all desktop executable files!");
} catch (err) {
  console.error("Error creating files:", err);
}