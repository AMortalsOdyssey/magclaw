const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '../public/avatars');

// 物件类调色板 - 更鲜艳活泼
const palettes = [
  { bg: '#1a1a2e', main: '#ff6b6b', accent: '#feca57', detail: '#fff' },
  { bg: '#0f0f23', main: '#00d9ff', accent: '#ff00ff', detail: '#fff' },
  { bg: '#1e1e2e', main: '#a6e3a1', accent: '#f38ba8', detail: '#fff' },
  { bg: '#2d1b4e', main: '#bd93f9', accent: '#ffb86c', detail: '#fff' },
  { bg: '#0d2b45', main: '#7ec8e3', accent: '#ff6b6b', detail: '#fff' },
  { bg: '#1b263b', main: '#e0aaff', accent: '#3ae374', detail: '#fff' },
  { bg: '#0a192f', main: '#64ffda', accent: '#f72585', detail: '#fff' },
  { bg: '#2c003e', main: '#ff79c6', accent: '#50fa7b', detail: '#fff' },
  { bg: '#0b090a', main: '#ffba08', accent: '#e5989b', detail: '#fff' },
  { bg: '#10002b', main: '#ff9e00', accent: '#c77dff', detail: '#fff' },
  { bg: '#03071e', main: '#f48c06', accent: '#00f5d4', detail: '#fff' },
  { bg: '#1a0a2e', main: '#ff6b9d', accent: '#50fa7b', detail: '#fff' },
];

// 物件基础形状
const objects = [
  // 冰箱
  (p) => `<rect x="8" y="4" width="16" height="24" fill="${p.main}"/>
          <rect x="10" y="6" width="12" height="8" fill="${p.bg}"/>
          <rect x="10" y="16" width="12" height="10" fill="${p.bg}"/>
          <rect x="22" y="10" width="2" height="4" fill="${p.accent}"/>
          <rect x="22" y="20" width="2" height="4" fill="${p.accent}"/>`,
  // 电视机
  (p) => `<rect x="4" y="6" width="24" height="18" fill="${p.main}"/>
          <rect x="6" y="8" width="20" height="14" fill="${p.bg}"/>
          <rect x="10" y="24" width="12" height="2" fill="${p.main}"/>
          <rect x="8" y="26" width="16" height="2" fill="${p.accent}"/>
          <rect x="26" y="8" width="2" height="4" fill="${p.accent}"/>`,
  // 机器人方块
  (p) => `<rect x="6" y="4" width="20" height="20" fill="${p.main}"/>
          <rect x="4" y="8" width="2" height="12" fill="${p.accent}"/>
          <rect x="26" y="8" width="2" height="12" fill="${p.accent}"/>
          <rect x="10" y="24" width="4" height="4" fill="${p.main}"/>
          <rect x="18" y="24" width="4" height="4" fill="${p.main}"/>`,
  // 书本
  (p) => `<rect x="6" y="6" width="20" height="22" fill="${p.main}"/>
          <rect x="8" y="6" width="2" height="22" fill="${p.accent}"/>
          <rect x="12" y="10" width="12" height="2" fill="${p.bg}"/>
          <rect x="12" y="14" width="10" height="2" fill="${p.bg}"/>
          <rect x="12" y="18" width="8" height="2" fill="${p.bg}"/>`,
  // 杯子
  (p) => `<rect x="8" y="8" width="14" height="18" fill="${p.main}"/>
          <rect x="10" y="10" width="10" height="14" fill="${p.bg}"/>
          <rect x="22" y="12" width="4" height="2" fill="${p.main}"/>
          <rect x="24" y="14" width="2" height="6" fill="${p.main}"/>
          <rect x="22" y="20" width="4" height="2" fill="${p.main}"/>`,
  // 灯泡
  (p) => `<rect x="10" y="4" width="12" height="16" fill="${p.accent}"/>
          <rect x="8" y="8" width="2" height="8" fill="${p.accent}"/>
          <rect x="22" y="8" width="2" height="8" fill="${p.accent}"/>
          <rect x="12" y="20" width="8" height="4" fill="${p.main}"/>
          <rect x="14" y="24" width="4" height="4" fill="${p.main}"/>`,
  // 信封
  (p) => `<rect x="4" y="8" width="24" height="16" fill="${p.main}"/>
          <rect x="6" y="10" width="20" height="12" fill="${p.bg}"/>
          <rect x="4" y="8" width="4" height="4" fill="${p.accent}"/>
          <rect x="8" y="12" width="4" height="4" fill="${p.accent}"/>
          <rect x="12" y="16" width="8" height="4" fill="${p.accent}"/>
          <rect x="20" y="12" width="4" height="4" fill="${p.accent}"/>
          <rect x="24" y="8" width="4" height="4" fill="${p.accent}"/>`,
  // 云朵
  (p) => `<rect x="8" y="12" width="16" height="10" fill="${p.main}"/>
          <rect x="6" y="14" width="4" height="6" fill="${p.main}"/>
          <rect x="22" y="14" width="4" height="6" fill="${p.main}"/>
          <rect x="12" y="8" width="8" height="6" fill="${p.main}"/>
          <rect x="10" y="10" width="4" height="4" fill="${p.main}"/>`,
  // 星星
  (p) => `<rect x="14" y="4" width="4" height="6" fill="${p.accent}"/>
          <rect x="4" y="12" width="24" height="4" fill="${p.accent}"/>
          <rect x="10" y="10" width="12" height="8" fill="${p.accent}"/>
          <rect x="12" y="18" width="8" height="4" fill="${p.accent}"/>
          <rect x="8" y="20" width="4" height="4" fill="${p.accent}"/>
          <rect x="20" y="20" width="4" height="4" fill="${p.accent}"/>
          <rect x="6" y="22" width="4" height="4" fill="${p.accent}"/>
          <rect x="22" y="22" width="4" height="4" fill="${p.accent}"/>`,
  // 心形
  (p) => `<rect x="6" y="10" width="8" height="8" fill="${p.accent}"/>
          <rect x="18" y="10" width="8" height="8" fill="${p.accent}"/>
          <rect x="8" y="8" width="6" height="4" fill="${p.accent}"/>
          <rect x="18" y="8" width="6" height="4" fill="${p.accent}"/>
          <rect x="10" y="18" width="12" height="4" fill="${p.accent}"/>
          <rect x="12" y="22" width="8" height="4" fill="${p.accent}"/>
          <rect x="14" y="26" width="4" height="2" fill="${p.accent}"/>`,
  // 钻石
  (p) => `<rect x="12" y="4" width="8" height="4" fill="${p.accent}"/>
          <rect x="8" y="8" width="16" height="4" fill="${p.accent}"/>
          <rect x="6" y="12" width="20" height="4" fill="${p.main}"/>
          <rect x="10" y="16" width="12" height="4" fill="${p.main}"/>
          <rect x="12" y="20" width="8" height="4" fill="${p.main}"/>
          <rect x="14" y="24" width="4" height="4" fill="${p.main}"/>`,
  // 火焰
  (p) => `<rect x="14" y="4" width="4" height="4" fill="${p.accent}"/>
          <rect x="12" y="8" width="8" height="4" fill="${p.accent}"/>
          <rect x="10" y="12" width="12" height="6" fill="${p.accent}"/>
          <rect x="8" y="16" width="16" height="6" fill="${p.main}"/>
          <rect x="10" y="22" width="12" height="4" fill="${p.main}"/>
          <rect x="12" y="26" width="8" height="2" fill="${p.main}"/>`,
  // 闪电
  (p) => `<rect x="16" y="2" width="6" height="4" fill="${p.accent}"/>
          <rect x="14" y="6" width="6" height="4" fill="${p.accent}"/>
          <rect x="12" y="10" width="8" height="4" fill="${p.accent}"/>
          <rect x="10" y="14" width="12" height="4" fill="${p.accent}"/>
          <rect x="14" y="18" width="6" height="4" fill="${p.accent}"/>
          <rect x="12" y="22" width="6" height="4" fill="${p.accent}"/>
          <rect x="10" y="26" width="6" height="4" fill="${p.accent}"/>`,
  // 音符
  (p) => `<rect x="18" y="4" width="4" height="16" fill="${p.main}"/>
          <rect x="12" y="16" width="8" height="6" fill="${p.accent}"/>
          <rect x="10" y="18" width="4" height="4" fill="${p.accent}"/>
          <rect x="18" y="4" width="6" height="2" fill="${p.main}"/>
          <rect x="22" y="6" width="2" height="4" fill="${p.main}"/>`,
  // 游戏手柄
  (p) => `<rect x="4" y="10" width="24" height="12" fill="${p.main}"/>
          <rect x="6" y="8" width="8" height="4" fill="${p.main}"/>
          <rect x="18" y="8" width="8" height="4" fill="${p.main}"/>
          <rect x="8" y="14" width="6" height="2" fill="${p.bg}"/>
          <rect x="10" y="12" width="2" height="6" fill="${p.bg}"/>
          <rect x="20" y="14" width="2" height="2" fill="${p.accent}"/>
          <rect x="24" y="14" width="2" height="2" fill="${p.accent}"/>`,
  // 相机
  (p) => `<rect x="4" y="10" width="24" height="14" fill="${p.main}"/>
          <rect x="10" y="6" width="8" height="6" fill="${p.main}"/>
          <rect x="12" y="14" width="8" height="8" fill="${p.bg}"/>
          <rect x="14" y="16" width="4" height="4" fill="${p.accent}"/>
          <rect x="22" y="12" width="4" height="2" fill="${p.accent}"/>`,
  // 礼物盒
  (p) => `<rect x="6" y="10" width="20" height="16" fill="${p.main}"/>
          <rect x="4" y="10" width="24" height="4" fill="${p.accent}"/>
          <rect x="14" y="10" width="4" height="16" fill="${p.accent}"/>
          <rect x="12" y="4" width="8" height="6" fill="${p.accent}"/>
          <rect x="10" y="6" width="4" height="4" fill="${p.accent}"/>
          <rect x="18" y="6" width="4" height="4" fill="${p.accent}"/>`,
  // 飞碟 UFO
  (p) => `<rect x="12" y="6" width="8" height="8" fill="${p.accent}"/>
          <rect x="10" y="10" width="12" height="4" fill="${p.accent}"/>
          <rect x="4" y="14" width="24" height="6" fill="${p.main}"/>
          <rect x="6" y="12" width="20" height="4" fill="${p.main}"/>
          <rect x="8" y="20" width="4" height="2" fill="${p.accent}"/>
          <rect x="20" y="20" width="4" height="2" fill="${p.accent}"/>
          <rect x="14" y="22" width="4" height="4" fill="${p.accent}"/>`,
  // 药丸
  (p) => `<rect x="8" y="10" width="16" height="12" fill="${p.main}"/>
          <rect x="10" y="8" width="12" height="4" fill="${p.main}"/>
          <rect x="10" y="20" width="12" height="4" fill="${p.accent}"/>
          <rect x="8" y="16" width="16" height="6" fill="${p.accent}"/>`,
  // 骰子
  (p) => `<rect x="6" y="6" width="20" height="20" fill="${p.main}"/>
          <rect x="10" y="10" width="4" height="4" fill="${p.detail}"/>
          <rect x="18" y="10" width="4" height="4" fill="${p.detail}"/>
          <rect x="14" y="14" width="4" height="4" fill="${p.detail}"/>
          <rect x="10" y="18" width="4" height="4" fill="${p.detail}"/>
          <rect x="18" y="18" width="4" height="4" fill="${p.detail}"/>`,
  // 植物盆栽
  (p) => `<rect x="10" y="18" width="12" height="10" fill="${p.accent}"/>
          <rect x="14" y="10" width="4" height="10" fill="${p.main}"/>
          <rect x="10" y="6" width="4" height="6" fill="${p.main}"/>
          <rect x="18" y="6" width="4" height="6" fill="${p.main}"/>
          <rect x="8" y="4" width="4" height="4" fill="${p.main}"/>
          <rect x="20" y="4" width="4" height="4" fill="${p.main}"/>
          <rect x="12" y="2" width="8" height="4" fill="${p.main}"/>`,
  // 齿轮
  (p) => `<rect x="10" y="10" width="12" height="12" fill="${p.main}"/>
          <rect x="14" y="4" width="4" height="6" fill="${p.main}"/>
          <rect x="14" y="22" width="4" height="6" fill="${p.main}"/>
          <rect x="4" y="14" width="6" height="4" fill="${p.main}"/>
          <rect x="22" y="14" width="6" height="4" fill="${p.main}"/>
          <rect x="14" y="14" width="4" height="4" fill="${p.bg}"/>`,
  // 奶酪
  (p) => `<rect x="4" y="12" width="24" height="14" fill="${p.accent}"/>
          <rect x="8" y="8" width="20" height="6" fill="${p.accent}"/>
          <rect x="8" y="16" width="4" height="4" fill="${p.bg}"/>
          <rect x="18" y="14" width="6" height="6" fill="${p.bg}"/>
          <rect x="12" y="22" width="4" height="4" fill="${p.bg}"/>`,
  // 汉堡
  (p) => `<rect x="6" y="6" width="20" height="6" fill="${p.accent}"/>
          <rect x="4" y="12" width="24" height="4" fill="${p.main}"/>
          <rect x="4" y="16" width="24" height="4" fill="#4ade80"/>
          <rect x="4" y="20" width="24" height="4" fill="${p.accent}"/>
          <rect x="6" y="24" width="20" height="4" fill="${p.accent}"/>
          <rect x="10" y="8" width="2" height="2" fill="${p.detail}"/>
          <rect x="16" y="8" width="2" height="2" fill="${p.detail}"/>`,
];

// 表情眼睛 - 给物件加上可爱的表情
const faceExpressions = [
  // 无表情
  () => ``,
  // 点眼
  (p, y) => `<rect x="10" y="${y}" width="2" height="2" fill="${p.detail}"/>
             <rect x="20" y="${y}" width="2" height="2" fill="${p.detail}"/>`,
  // 大眼
  (p, y) => `<rect x="8" y="${y}" width="4" height="4" fill="${p.detail}"/>
             <rect x="20" y="${y}" width="4" height="4" fill="${p.detail}"/>
             <rect x="9" y="${y+1}" width="2" height="2" fill="${p.bg}"/>
             <rect x="21" y="${y+1}" width="2" height="2" fill="${p.bg}"/>`,
  // 眯眯眼
  (p, y) => `<rect x="8" y="${y}" width="4" height="2" fill="${p.detail}"/>
             <rect x="20" y="${y}" width="4" height="2" fill="${p.detail}"/>`,
  // 开心眼 ^_^
  (p, y) => `<rect x="8" y="${y}" width="2" height="2" fill="${p.detail}"/>
             <rect x="10" y="${y-2}" width="2" height="2" fill="${p.detail}"/>
             <rect x="12" y="${y}" width="2" height="2" fill="${p.detail}"/>
             <rect x="18" y="${y}" width="2" height="2" fill="${p.detail}"/>
             <rect x="20" y="${y-2}" width="2" height="2" fill="${p.detail}"/>
             <rect x="22" y="${y}" width="2" height="2" fill="${p.detail}"/>`,
  // 星星眼
  (p, y) => `<rect x="10" y="${y}" width="2" height="2" fill="${p.accent}"/>
             <rect x="8" y="${y+2}" width="6" height="2" fill="${p.accent}"/>
             <rect x="10" y="${y+4}" width="2" height="2" fill="${p.accent}"/>
             <rect x="20" y="${y}" width="2" height="2" fill="${p.accent}"/>
             <rect x="18" y="${y+2}" width="6" height="2" fill="${p.accent}"/>
             <rect x="20" y="${y+4}" width="2" height="2" fill="${p.accent}"/>`,
];

// 装饰元素
const decorations = [
  () => ``,
  // 小光芒
  (p) => `<rect x="4" y="4" width="2" height="2" fill="${p.accent}"/>
          <rect x="2" y="6" width="2" height="2" fill="${p.accent}" opacity="0.6"/>`,
  // 小星星
  (p) => `<rect x="26" y="4" width="2" height="2" fill="${p.accent}"/>
          <rect x="24" y="6" width="2" height="2" fill="${p.accent}" opacity="0.5"/>
          <rect x="28" y="6" width="2" height="2" fill="${p.accent}" opacity="0.5"/>`,
  // 小心心
  (p) => `<rect x="4" y="4" width="2" height="2" fill="${p.accent}"/>
          <rect x="8" y="4" width="2" height="2" fill="${p.accent}"/>
          <rect x="4" y="6" width="6" height="2" fill="${p.accent}"/>
          <rect x="6" y="8" width="2" height="2" fill="${p.accent}"/>`,
  // 音符
  (p) => `<rect x="26" y="4" width="2" height="6" fill="${p.accent}"/>
          <rect x="24" y="8" width="4" height="2" fill="${p.accent}"/>`,
  // Z字睡眠
  (p) => `<rect x="24" y="4" width="6" height="2" fill="${p.accent}"/>
          <rect x="26" y="6" width="2" height="2" fill="${p.accent}"/>
          <rect x="24" y="8" width="6" height="2" fill="${p.accent}"/>`,
];

function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function generateObjectAvatar(index) {
  const random = seededRandom(index * 7919 + 2000);
  const palette = palettes[Math.floor(random() * palettes.length)];
  const objectIdx = Math.floor(random() * objects.length);
  const faceIdx = Math.floor(random() * faceExpressions.length);
  const decoIdx = Math.floor(random() * decorations.length);

  const faceY = 12 + Math.floor(random() * 4);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${palette.bg}"/>
  ${objects[objectIdx](palette)}
  ${faceExpressions[faceIdx](palette, faceY)}
  ${decorations[decoIdx](palette)}
</svg>`.split('\n').map((line) => line.trimEnd()).join('\n');
}

console.log('Generating 1000 object avatars (1001-2000)...');
for (let i = 0; i < 1000; i++) {
  const svg = generateObjectAvatar(i);
  const filename = `avatar_${String(i + 1001).padStart(4, '0')}.svg`;
  fs.writeFileSync(path.join(outputDir, filename), svg);
  if ((i + 1) % 100 === 0) {
    console.log(`Generated ${i + 1}/1000 object avatars`);
  }
}

console.log('Done! 1000 object avatars generated (avatar_1001.svg ~ avatar_2000.svg)');
console.log(`- ${objects.length} object types`);
console.log(`- ${faceExpressions.length} face expressions`);
console.log(`- ${decorations.length} decorations`);
console.log(`- ${palettes.length} color palettes`);
