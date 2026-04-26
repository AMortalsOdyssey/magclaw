const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '../public/avatars');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// 丰富的调色板 - 每个颜色组合都很大胆
const colorPalettes = [
  { bg: '#1a0a2e', skin: '#ffdbac', accent: '#ff6b9d', secondary: '#50fa7b', eye: '#1a0a2e' },
  { bg: '#0f380f', skin: '#9bbc0f', accent: '#8bac0f', secondary: '#306230', eye: '#0f380f' },
  { bg: '#2c003e', skin: '#ff79c6', accent: '#bd93f9', secondary: '#50fa7b', eye: '#2c003e' },
  { bg: '#1a1c2c', skin: '#f4f4f4', accent: '#94b0c2', secondary: '#566c86', eye: '#1a1c2c' },
  { bg: '#0d2b45', skin: '#ffce96', accent: '#ff6b6b', secondary: '#7ec8e3', eye: '#0d2b45' },
  { bg: '#3f2832', skin: '#ff9f43', accent: '#feca57', secondary: '#ff6b6b', eye: '#3f2832' },
  { bg: '#0c0c1d', skin: '#00d9ff', accent: '#ff00ff', secondary: '#00ff87', eye: '#0c0c1d' },
  { bg: '#1e1e2e', skin: '#fab387', accent: '#f38ba8', secondary: '#a6e3a1', eye: '#1e1e2e' },
  { bg: '#282a36', skin: '#f8f8f2', accent: '#ff79c6', secondary: '#8be9fd', eye: '#282a36' },
  { bg: '#2d1b4e', skin: '#ff6348', accent: '#ffc048', secondary: '#3ae374', eye: '#2d1b4e' },
  { bg: '#0a192f', skin: '#64ffda', accent: '#f72585', secondary: '#7209b7', eye: '#0a192f' },
  { bg: '#1b263b', skin: '#e0aaff', accent: '#c77dff', secondary: '#9d4edd', eye: '#1b263b' },
  { bg: '#10002b', skin: '#e0aaff', accent: '#ff9e00', secondary: '#ffea00', eye: '#10002b' },
  { bg: '#03071e', skin: '#ffba08', accent: '#f48c06', secondary: '#dc2f02', eye: '#03071e' },
  { bg: '#0b090a', skin: '#b5838d', accent: '#e5989b', secondary: '#ffb4a2', eye: '#0b090a' },
];

// 头部基础形状
const heads = [
  // 圆形头
  (p) => `<rect x="6" y="6" width="20" height="20" fill="${p.skin}"/>
          <rect x="8" y="4" width="16" height="2" fill="${p.skin}"/>
          <rect x="8" y="26" width="16" height="2" fill="${p.skin}"/>
          <rect x="4" y="8" width="2" height="16" fill="${p.skin}"/>
          <rect x="26" y="8" width="2" height="16" fill="${p.skin}"/>`,
  // 方形头
  (p) => `<rect x="4" y="4" width="24" height="24" fill="${p.skin}"/>`,
  // 高头
  (p) => `<rect x="6" y="2" width="20" height="26" fill="${p.skin}"/>
          <rect x="4" y="6" width="2" height="18" fill="${p.skin}"/>
          <rect x="26" y="6" width="2" height="18" fill="${p.skin}"/>`,
  // 宽头
  (p) => `<rect x="2" y="8" width="28" height="18" fill="${p.skin}"/>
          <rect x="6" y="6" width="20" height="2" fill="${p.skin}"/>
          <rect x="6" y="26" width="20" height="2" fill="${p.skin}"/>`,
  // 梯形头
  (p) => `<rect x="8" y="4" width="16" height="4" fill="${p.skin}"/>
          <rect x="6" y="8" width="20" height="4" fill="${p.skin}"/>
          <rect x="4" y="12" width="24" height="16" fill="${p.skin}"/>`,
  // 倒梯形
  (p) => `<rect x="4" y="4" width="24" height="16" fill="${p.skin}"/>
          <rect x="6" y="20" width="20" height="4" fill="${p.skin}"/>
          <rect x="8" y="24" width="16" height="4" fill="${p.skin}"/>`,
];

// 眼睛样式 - 12种不同造型
const eyes = [
  // 大圆眼
  (p, y) => `<rect x="8" y="${y}" width="6" height="6" fill="${p.eye}"/>
             <rect x="18" y="${y}" width="6" height="6" fill="${p.eye}"/>
             <rect x="10" y="${y+1}" width="2" height="2" fill="#fff"/>
             <rect x="20" y="${y+1}" width="2" height="2" fill="#fff"/>`,
  // 小点眼
  (p, y) => `<rect x="10" y="${y+2}" width="2" height="2" fill="${p.eye}"/>
             <rect x="20" y="${y+2}" width="2" height="2" fill="${p.eye}"/>`,
  // 眯眼
  (p, y) => `<rect x="8" y="${y+2}" width="6" height="2" fill="${p.eye}"/>
             <rect x="18" y="${y+2}" width="6" height="2" fill="${p.eye}"/>`,
  // X眼
  (p, y) => `<rect x="8" y="${y}" width="2" height="2" fill="${p.eye}"/>
             <rect x="10" y="${y+2}" width="2" height="2" fill="${p.eye}"/>
             <rect x="12" y="${y}" width="2" height="2" fill="${p.eye}"/>
             <rect x="8" y="${y+4}" width="2" height="2" fill="${p.eye}"/>
             <rect x="12" y="${y+4}" width="2" height="2" fill="${p.eye}"/>
             <rect x="18" y="${y}" width="2" height="2" fill="${p.eye}"/>
             <rect x="20" y="${y+2}" width="2" height="2" fill="${p.eye}"/>
             <rect x="22" y="${y}" width="2" height="2" fill="${p.eye}"/>
             <rect x="18" y="${y+4}" width="2" height="2" fill="${p.eye}"/>
             <rect x="22" y="${y+4}" width="2" height="2" fill="${p.eye}"/>`,
  // 竖眼
  (p, y) => `<rect x="10" y="${y}" width="2" height="6" fill="${p.eye}"/>
             <rect x="20" y="${y}" width="2" height="6" fill="${p.eye}"/>`,
  // 方眼
  (p, y) => `<rect x="7" y="${y}" width="8" height="6" fill="#fff"/>
             <rect x="17" y="${y}" width="8" height="6" fill="#fff"/>
             <rect x="8" y="${y+1}" width="3" height="4" fill="${p.eye}"/>
             <rect x="21" y="${y+1}" width="3" height="4" fill="${p.eye}"/>`,
  // 爱心眼
  (p, y) => `<rect x="8" y="${y+1}" width="2" height="2" fill="${p.accent}"/>
             <rect x="12" y="${y+1}" width="2" height="2" fill="${p.accent}"/>
             <rect x="8" y="${y+3}" width="6" height="2" fill="${p.accent}"/>
             <rect x="10" y="${y+5}" width="2" height="2" fill="${p.accent}"/>
             <rect x="18" y="${y+1}" width="2" height="2" fill="${p.accent}"/>
             <rect x="22" y="${y+1}" width="2" height="2" fill="${p.accent}"/>
             <rect x="18" y="${y+3}" width="6" height="2" fill="${p.accent}"/>
             <rect x="20" y="${y+5}" width="2" height="2" fill="${p.accent}"/>`,
  // 星星眼
  (p, y) => `<rect x="10" y="${y}" width="2" height="2" fill="${p.accent}"/>
             <rect x="8" y="${y+2}" width="6" height="2" fill="${p.accent}"/>
             <rect x="10" y="${y+4}" width="2" height="2" fill="${p.accent}"/>
             <rect x="20" y="${y}" width="2" height="2" fill="${p.accent}"/>
             <rect x="18" y="${y+2}" width="6" height="2" fill="${p.accent}"/>
             <rect x="20" y="${y+4}" width="2" height="2" fill="${p.accent}"/>`,
  // 机器人眼（LED）
  (p, y) => `<rect x="7" y="${y}" width="8" height="6" fill="${p.bg}"/>
             <rect x="17" y="${y}" width="8" height="6" fill="${p.bg}"/>
             <rect x="9" y="${y+2}" width="4" height="2" fill="${p.secondary}"/>
             <rect x="19" y="${y+2}" width="4" height="2" fill="${p.secondary}"/>`,
  // 眼镜眼（Nouns风格）
  (p, y) => `<rect x="5" y="${y}" width="10" height="8" fill="${p.accent}"/>
             <rect x="17" y="${y}" width="10" height="8" fill="${p.accent}"/>
             <rect x="15" y="${y+2}" width="2" height="4" fill="${p.accent}"/>
             <rect x="7" y="${y+2}" width="6" height="4" fill="#fff"/>
             <rect x="19" y="${y+2}" width="6" height="4" fill="#fff"/>
             <rect x="9" y="${y+3}" width="2" height="2" fill="${p.eye}"/>
             <rect x="21" y="${y+3}" width="2" height="2" fill="${p.eye}"/>`,
  // 独眼
  (p, y) => `<rect x="12" y="${y}" width="8" height="8" fill="#fff"/>
             <rect x="14" y="${y+2}" width="4" height="4" fill="${p.eye}"/>
             <rect x="15" y="${y+3}" width="2" height="2" fill="${p.accent}"/>`,
  // 眼罩
  (p, y) => `<rect x="6" y="${y}" width="10" height="6" fill="${p.eye}"/>
             <rect x="8" y="${y+2}" width="2" height="2" fill="${p.accent}"/>
             <rect x="18" y="${y}" width="6" height="6" fill="#fff"/>
             <rect x="20" y="${y+2}" width="2" height="2" fill="${p.eye}"/>`,
];

// 嘴巴样式 - 10种
const mouths = [
  // 微笑
  (p, y) => `<rect x="12" y="${y}" width="8" height="2" fill="${p.eye}"/>
             <rect x="10" y="${y-2}" width="2" height="2" fill="${p.eye}"/>
             <rect x="20" y="${y-2}" width="2" height="2" fill="${p.eye}"/>`,
  // 直线嘴
  (p, y) => `<rect x="12" y="${y}" width="8" height="2" fill="${p.eye}"/>`,
  // O嘴
  (p, y) => `<rect x="13" y="${y-1}" width="6" height="4" fill="${p.eye}"/>
             <rect x="14" y="${y}" width="4" height="2" fill="${p.accent}"/>`,
  // 咧嘴笑
  (p, y) => `<rect x="10" y="${y}" width="12" height="4" fill="${p.eye}"/>
             <rect x="12" y="${y}" width="8" height="2" fill="#fff"/>`,
  // 无嘴
  (p, y) => ``,
  // 尖牙
  (p, y) => `<rect x="10" y="${y}" width="12" height="2" fill="${p.eye}"/>
             <rect x="12" y="${y+2}" width="2" height="2" fill="#fff"/>
             <rect x="18" y="${y+2}" width="2" height="2" fill="#fff"/>`,
  // 吐舌
  (p, y) => `<rect x="12" y="${y}" width="8" height="2" fill="${p.eye}"/>
             <rect x="14" y="${y+2}" width="4" height="4" fill="${p.accent}"/>`,
  // 波浪嘴
  (p, y) => `<rect x="10" y="${y}" width="2" height="2" fill="${p.eye}"/>
             <rect x="12" y="${y+2}" width="2" height="2" fill="${p.eye}"/>
             <rect x="14" y="${y}" width="4" height="2" fill="${p.eye}"/>
             <rect x="18" y="${y+2}" width="2" height="2" fill="${p.eye}"/>
             <rect x="20" y="${y}" width="2" height="2" fill="${p.eye}"/>`,
  // 胡子
  (p, y) => `<rect x="8" y="${y}" width="16" height="2" fill="${p.secondary}"/>
             <rect x="10" y="${y+2}" width="4" height="4" fill="${p.secondary}"/>
             <rect x="18" y="${y+2}" width="4" height="4" fill="${p.secondary}"/>
             <rect x="14" y="${y+2}" width="4" height="2" fill="${p.secondary}"/>`,
  // 机器嘴
  (p, y) => `<rect x="10" y="${y}" width="12" height="4" fill="${p.bg}"/>
             <rect x="12" y="${y+1}" width="2" height="2" fill="${p.secondary}"/>
             <rect x="16" y="${y+1}" width="2" height="2" fill="${p.secondary}"/>
             <rect x="20" y="${y+1}" width="2" height="2" fill="${p.secondary}"/>`,
];

// 配件（帽子/头饰）- 15种
const accessories = [
  // 无
  (p) => ``,
  // 尖帽子
  (p) => `<rect x="14" y="0" width="4" height="4" fill="${p.accent}"/>
          <rect x="12" y="4" width="8" height="2" fill="${p.accent}"/>
          <rect x="10" y="6" width="12" height="2" fill="${p.accent}"/>`,
  // 皇冠
  (p) => `<rect x="8" y="2" width="16" height="4" fill="${p.accent}"/>
          <rect x="10" y="0" width="2" height="2" fill="${p.accent}"/>
          <rect x="15" y="0" width="2" height="2" fill="${p.accent}"/>
          <rect x="20" y="0" width="2" height="2" fill="${p.accent}"/>
          <rect x="14" y="3" width="4" height="2" fill="${p.secondary}"/>`,
  // 角
  (p) => `<rect x="6" y="0" width="4" height="6" fill="${p.accent}"/>
          <rect x="22" y="0" width="4" height="6" fill="${p.accent}"/>
          <rect x="4" y="2" width="2" height="2" fill="${p.accent}"/>
          <rect x="26" y="2" width="2" height="2" fill="${p.accent}"/>`,
  // 天线
  (p) => `<rect x="10" y="0" width="2" height="6" fill="${p.secondary}"/>
          <rect x="20" y="0" width="2" height="6" fill="${p.secondary}"/>
          <rect x="8" y="0" width="2" height="2" fill="${p.accent}"/>
          <rect x="22" y="0" width="2" height="2" fill="${p.accent}"/>`,
  // 礼帽
  (p) => `<rect x="6" y="2" width="20" height="2" fill="${p.eye}"/>
          <rect x="10" y="0" width="12" height="2" fill="${p.eye}"/>
          <rect x="12" y="-4" width="8" height="4" fill="${p.eye}"/>
          <rect x="14" y="-2" width="4" height="2" fill="${p.accent}"/>`,
  // 发髻
  (p) => `<rect x="12" y="0" width="8" height="6" fill="${p.secondary}"/>
          <rect x="10" y="2" width="2" height="4" fill="${p.secondary}"/>
          <rect x="20" y="2" width="2" height="4" fill="${p.secondary}"/>`,
  // 光环
  (p) => `<rect x="8" y="0" width="16" height="2" fill="${p.accent}"/>
          <rect x="6" y="2" width="2" height="2" fill="${p.accent}"/>
          <rect x="24" y="2" width="2" height="2" fill="${p.accent}"/>`,
  // 耳朵（猫耳）
  (p) => `<rect x="4" y="0" width="6" height="8" fill="${p.skin}"/>
          <rect x="22" y="0" width="6" height="8" fill="${p.skin}"/>
          <rect x="6" y="2" width="2" height="4" fill="${p.accent}"/>
          <rect x="24" y="2" width="2" height="4" fill="${p.accent}"/>`,
  // 兔耳
  (p) => `<rect x="8" y="-6" width="4" height="12" fill="${p.skin}"/>
          <rect x="20" y="-6" width="4" height="12" fill="${p.skin}"/>
          <rect x="9" y="-4" width="2" height="8" fill="${p.accent}"/>
          <rect x="21" y="-4" width="2" height="8" fill="${p.accent}"/>`,
  // 蘑菇头
  (p) => `<rect x="4" y="0" width="24" height="8" fill="${p.accent}"/>
          <rect x="6" y="-2" width="20" height="2" fill="${p.accent}"/>
          <rect x="10" y="2" width="4" height="4" fill="#fff"/>
          <rect x="18" y="2" width="4" height="4" fill="#fff"/>`,
  // 花
  (p) => `<rect x="14" y="0" width="4" height="4" fill="${p.accent}"/>
          <rect x="12" y="2" width="2" height="4" fill="${p.accent}"/>
          <rect x="18" y="2" width="2" height="4" fill="${p.accent}"/>
          <rect x="14" y="4" width="4" height="2" fill="${p.accent}"/>
          <rect x="15" y="2" width="2" height="2" fill="${p.secondary}"/>`,
  // 蝴蝶结
  (p) => `<rect x="6" y="2" width="8" height="4" fill="${p.accent}"/>
          <rect x="18" y="2" width="8" height="4" fill="${p.accent}"/>
          <rect x="14" y="3" width="4" height="2" fill="${p.accent}"/>`,
  // 朋克头
  (p) => `<rect x="14" y="-4" width="4" height="10" fill="${p.accent}"/>
          <rect x="12" y="0" width="2" height="6" fill="${p.accent}"/>
          <rect x="18" y="0" width="2" height="6" fill="${p.accent}"/>`,
  // 闪电
  (p) => `<rect x="12" y="0" width="4" height="4" fill="${p.accent}"/>
          <rect x="14" y="2" width="6" height="2" fill="${p.accent}"/>
          <rect x="16" y="4" width="4" height="4" fill="${p.accent}"/>`,
];

// 特殊装饰 - 8种
const decorations = [
  // 无
  (p) => ``,
  // 腮红
  (p) => `<rect x="4" y="16" width="4" height="2" fill="${p.accent}" opacity="0.5"/>
          <rect x="24" y="16" width="4" height="2" fill="${p.accent}" opacity="0.5"/>`,
  // 伤疤
  (p) => `<rect x="20" y="10" width="6" height="2" fill="${p.secondary}"/>
          <rect x="22" y="8" width="2" height="6" fill="${p.secondary}"/>`,
  // 泪滴
  (p) => `<rect x="6" y="16" width="2" height="4" fill="#00d9ff"/>
          <rect x="6" y="20" width="2" height="2" fill="#00d9ff"/>`,
  // 雀斑
  (p) => `<rect x="6" y="14" width="2" height="2" fill="${p.secondary}" opacity="0.6"/>
          <rect x="8" y="16" width="2" height="2" fill="${p.secondary}" opacity="0.6"/>
          <rect x="24" y="14" width="2" height="2" fill="${p.secondary}" opacity="0.6"/>
          <rect x="22" y="16" width="2" height="2" fill="${p.secondary}" opacity="0.6"/>`,
  // 面具纹
  (p) => `<rect x="4" y="12" width="2" height="8" fill="${p.accent}"/>
          <rect x="26" y="12" width="2" height="8" fill="${p.accent}"/>
          <rect x="6" y="14" width="2" height="4" fill="${p.accent}"/>
          <rect x="24" y="14" width="2" height="4" fill="${p.accent}"/>`,
  // 机械零件
  (p) => `<rect x="24" y="8" width="4" height="4" fill="${p.bg}"/>
          <rect x="25" y="9" width="2" height="2" fill="${p.secondary}"/>
          <rect x="26" y="12" width="2" height="4" fill="${p.secondary}"/>`,
  // 闪光
  (p) => `<rect x="4" y="4" width="2" height="2" fill="#fff"/>
          <rect x="2" y="6" width="2" height="2" fill="#fff" opacity="0.6"/>
          <rect x="6" y="6" width="2" height="2" fill="#fff" opacity="0.6"/>`,
];

// 表情符号叠加 - 用于增加趣味性
const overlays = [
  // 无
  () => ``,
  // 汗滴
  (p) => `<rect x="26" y="6" width="2" height="4" fill="#00d9ff"/>
          <rect x="26" y="10" width="2" height="2" fill="#00d9ff"/>`,
  // 愤怒线
  (p) => `<rect x="2" y="2" width="4" height="2" fill="${p.accent}"/>
          <rect x="4" y="4" width="4" height="2" fill="${p.accent}"/>`,
  // 音符
  (p) => `<rect x="26" y="2" width="2" height="6" fill="${p.accent}"/>
          <rect x="24" y="6" width="4" height="4" fill="${p.accent}"/>`,
  // 问号
  (p) => `<rect x="26" y="2" width="4" height="2" fill="${p.accent}"/>
          <rect x="28" y="4" width="2" height="2" fill="${p.accent}"/>
          <rect x="26" y="6" width="2" height="2" fill="${p.accent}"/>
          <rect x="26" y="10" width="2" height="2" fill="${p.accent}"/>`,
];

function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function generateAvatar(index) {
  const random = seededRandom(index * 7919 + 1);
  const palette = colorPalettes[Math.floor(random() * colorPalettes.length)];

  const headIdx = Math.floor(random() * heads.length);
  const eyeIdx = Math.floor(random() * eyes.length);
  const mouthIdx = Math.floor(random() * mouths.length);
  const accessoryIdx = Math.floor(random() * accessories.length);
  const decorationIdx = Math.floor(random() * decorations.length);
  const overlayIdx = Math.floor(random() * overlays.length);

  // 根据头部形状调整眼睛和嘴巴位置
  const eyeY = headIdx === 2 ? 8 : headIdx === 3 ? 12 : 10;
  const mouthY = headIdx === 2 ? 18 : headIdx === 3 ? 20 : 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${palette.bg}"/>
  ${heads[headIdx](palette)}
  ${eyes[eyeIdx](palette, eyeY)}
  ${mouths[mouthIdx](palette, mouthY)}
  ${accessories[accessoryIdx](palette)}
  ${decorations[decorationIdx](palette)}
  ${overlays[overlayIdx](palette)}
</svg>`;
}

// 清空旧文件
const existingFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('avatar_'));
existingFiles.forEach(f => fs.unlinkSync(path.join(outputDir, f)));

// 生成200个头像
console.log('Generating 200 unique avatars with component-based design...');
for (let i = 0; i < 200; i++) {
  const svg = generateAvatar(i);
  const filename = `avatar_${String(i + 1).padStart(3, '0')}.svg`;
  fs.writeFileSync(path.join(outputDir, filename), svg);
  if ((i + 1) % 50 === 0) {
    console.log(`Generated ${i + 1}/200 avatars`);
  }
}

console.log('Done! 200 unique avatars generated with:');
console.log(`- ${heads.length} head shapes`);
console.log(`- ${eyes.length} eye styles`);
console.log(`- ${mouths.length} mouth styles`);
console.log(`- ${accessories.length} accessories`);
console.log(`- ${decorations.length} decorations`);
console.log(`- ${colorPalettes.length} color palettes`);
console.log(`Total combinations: ${heads.length * eyes.length * mouths.length * accessories.length * decorations.length * colorPalettes.length}`);
