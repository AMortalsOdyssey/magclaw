const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '../public/avatars');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// 丰富的调色板
const palettes = [
  { bg: '#1a0a2e', primary: '#ff6b9d', secondary: '#50fa7b', accent: '#ffd93d', highlight: '#fff' },
  { bg: '#0a192f', primary: '#64ffda', secondary: '#ff79c6', accent: '#f1fa8c', highlight: '#fff' },
  { bg: '#2d1b4e', primary: '#bd93f9', secondary: '#ff9f43', accent: '#50fa7b', highlight: '#fff' },
  { bg: '#1a3a5c', primary: '#00d9ff', secondary: '#ff6b6b', accent: '#ffd93d', highlight: '#fff' },
  { bg: '#0d0d0d', primary: '#ff4757', secondary: '#2ed573', accent: '#ffa502', highlight: '#fff' },
  { bg: '#192a56', primary: '#f368e0', secondary: '#48dbfb', accent: '#ff9f43', highlight: '#fff' },
  { bg: '#1e272e', primary: '#0be881', secondary: '#f53b57', accent: '#ffdd59', highlight: '#fff' },
  { bg: '#2c2c54', primary: '#ff6348', secondary: '#3ae374', accent: '#ffb142', highlight: '#fff' },
  { bg: '#1b1464', primary: '#6c5ce7', secondary: '#fd79a8', accent: '#00cec9', highlight: '#fff' },
  { bg: '#0c0c0c', primary: '#e74c3c', secondary: '#9b59b6', accent: '#1abc9c', highlight: '#fff' },
  { bg: '#2f3542', primary: '#ff4757', secondary: '#70a1ff', accent: '#ffa502', highlight: '#eccc68' },
  { bg: '#130f40', primary: '#e056fd', secondary: '#7ed6df', accent: '#f9ca24', highlight: '#fff' },
  { bg: '#1a1a2e', primary: '#16a085', secondary: '#e74c3c', accent: '#f39c12', highlight: '#fff' },
  { bg: '#0f0f23', primary: '#ffbe0b', secondary: '#fb5607', accent: '#8338ec', highlight: '#3a86ff' },
  { bg: '#1c2833', primary: '#00ff87', secondary: '#ff0055', accent: '#00d4ff', highlight: '#fff' },
];

function getPalette(index) {
  return palettes[index % palettes.length];
}

// 生成器函数
const generators = {
  // 1. 机器人系列 (1-25)
  robot: (i, p) => {
    const variants = [
      // 圆头机器人
      `<rect x="8" y="6" width="16" height="16" fill="${p.primary}"/>
       <rect x="10" y="8" width="12" height="12" fill="${p.bg}"/>
       <rect x="12" y="10" width="3" height="3" fill="${p.secondary}"/>
       <rect x="17" y="10" width="3" height="3" fill="${p.secondary}"/>
       <rect x="13" y="15" width="6" height="2" fill="${p.accent}"/>
       <rect x="14" y="2" width="4" height="4" fill="${p.accent}"/>
       <rect x="6" y="10" width="2" height="6" fill="${p.secondary}"/>
       <rect x="24" y="10" width="2" height="6" fill="${p.secondary}"/>
       <rect x="10" y="22" width="4" height="4" fill="${p.primary}"/>
       <rect x="18" y="22" width="4" height="4" fill="${p.primary}"/>`,
      // 方头机器人
      `<rect x="6" y="4" width="20" height="20" fill="${p.primary}"/>
       <rect x="8" y="6" width="16" height="16" fill="${p.bg}"/>
       <rect x="10" y="8" width="4" height="6" fill="${p.secondary}"/>
       <rect x="18" y="8" width="4" height="6" fill="${p.secondary}"/>
       <rect x="11" y="9" width="2" height="2" fill="${p.highlight}"/>
       <rect x="19" y="9" width="2" height="2" fill="${p.highlight}"/>
       <rect x="12" y="16" width="8" height="4" fill="${p.accent}"/>
       <rect x="14" y="18" width="2" height="2" fill="${p.bg}"/>
       <rect x="4" y="8" width="2" height="8" fill="${p.accent}"/>
       <rect x="26" y="8" width="2" height="8" fill="${p.accent}"/>`,
      // 天线机器人
      `<rect x="14" y="0" width="4" height="6" fill="${p.secondary}"/>
       <rect x="12" y="0" width="2" height="2" fill="${p.accent}"/>
       <rect x="18" y="0" width="2" height="2" fill="${p.accent}"/>
       <rect x="8" y="6" width="16" height="18" fill="${p.primary}"/>
       <rect x="10" y="10" width="4" height="4" fill="${p.highlight}"/>
       <rect x="18" y="10" width="4" height="4" fill="${p.highlight}"/>
       <rect x="11" y="11" width="2" height="2" fill="${p.bg}"/>
       <rect x="19" y="11" width="2" height="2" fill="${p.bg}"/>
       <rect x="12" y="18" width="8" height="2" fill="${p.secondary}"/>
       <rect x="10" y="24" width="12" height="4" fill="${p.accent}"/>`,
      // 圆眼机器人
      `<rect x="6" y="8" width="20" height="16" fill="${p.primary}"/>
       <rect x="4" y="12" width="4" height="8" fill="${p.secondary}"/>
       <rect x="24" y="12" width="4" height="8" fill="${p.secondary}"/>
       <rect x="9" y="12" width="6" height="6" rx="3" fill="${p.highlight}"/>
       <rect x="17" y="12" width="6" height="6" rx="3" fill="${p.highlight}"/>
       <rect x="11" y="14" width="2" height="2" fill="${p.bg}"/>
       <rect x="19" y="14" width="2" height="2" fill="${p.bg}"/>
       <rect x="12" y="20" width="8" height="2" fill="${p.accent}"/>
       <rect x="10" y="24" width="12" height="4" fill="${p.primary}"/>`,
      // 屏幕脸机器人
      `<rect x="6" y="4" width="20" height="24" fill="${p.primary}"/>
       <rect x="8" y="6" width="16" height="14" fill="${p.bg}"/>
       <rect x="10" y="8" width="3" height="3" fill="${p.secondary}"/>
       <rect x="19" y="8" width="3" height="3" fill="${p.secondary}"/>
       <rect x="10" y="14" width="12" height="4" fill="${p.accent}"/>
       <rect x="4" y="10" width="2" height="4" fill="${p.accent}"/>
       <rect x="26" y="10" width="2" height="4" fill="${p.accent}"/>
       <rect x="12" y="22" width="8" height="6" fill="${p.secondary}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 2. 猫系列 (26-45)
  cat: (i, p) => {
    const variants = [
      // 基础猫
      `<rect x="4" y="4" width="6" height="8" fill="${p.primary}"/>
       <rect x="22" y="4" width="6" height="8" fill="${p.primary}"/>
       <rect x="4" y="10" width="24" height="16" fill="${p.primary}"/>
       <rect x="8" y="14" width="4" height="4" fill="${p.highlight}"/>
       <rect x="20" y="14" width="4" height="4" fill="${p.highlight}"/>
       <rect x="9" y="15" width="2" height="2" fill="${p.bg}"/>
       <rect x="21" y="15" width="2" height="2" fill="${p.bg}"/>
       <rect x="14" y="18" width="4" height="2" fill="${p.secondary}"/>
       <rect x="12" y="20" width="2" height="2" fill="${p.bg}"/>
       <rect x="18" y="20" width="2" height="2" fill="${p.bg}"/>`,
      // 条纹猫
      `<rect x="4" y="4" width="6" height="8" fill="${p.primary}"/>
       <rect x="22" y="4" width="6" height="8" fill="${p.primary}"/>
       <rect x="4" y="10" width="24" height="16" fill="${p.primary}"/>
       <rect x="8" y="10" width="2" height="16" fill="${p.secondary}"/>
       <rect x="14" y="10" width="4" height="6" fill="${p.secondary}"/>
       <rect x="22" y="10" width="2" height="16" fill="${p.secondary}"/>
       <rect x="10" y="14" width="3" height="3" fill="${p.highlight}"/>
       <rect x="19" y="14" width="3" height="3" fill="${p.highlight}"/>
       <rect x="14" y="18" width="4" height="2" fill="${p.accent}"/>`,
      // 圆脸猫
      `<rect x="6" y="6" width="20" height="20" fill="${p.primary}"/>
       <rect x="4" y="2" width="6" height="6" fill="${p.primary}"/>
       <rect x="22" y="2" width="6" height="6" fill="${p.primary}"/>
       <rect x="6" y="4" width="2" height="2" fill="${p.secondary}"/>
       <rect x="24" y="4" width="2" height="2" fill="${p.secondary}"/>
       <rect x="10" y="12" width="4" height="4" fill="${p.highlight}"/>
       <rect x="18" y="12" width="4" height="4" fill="${p.highlight}"/>
       <rect x="14" y="18" width="4" height="3" fill="${p.accent}"/>`,
      // 眯眼猫
      `<rect x="4" y="6" width="24" height="18" fill="${p.primary}"/>
       <rect x="2" y="2" width="6" height="6" fill="${p.primary}"/>
       <rect x="24" y="2" width="6" height="6" fill="${p.primary}"/>
       <rect x="8" y="14" width="6" height="2" fill="${p.bg}"/>
       <rect x="18" y="14" width="6" height="2" fill="${p.bg}"/>
       <rect x="14" y="18" width="4" height="2" fill="${p.secondary}"/>
       <rect x="12" y="20" width="8" height="2" fill="${p.accent}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 3. 狗系列 (46-60)
  dog: (i, p) => {
    const variants = [
      `<rect x="4" y="6" width="8" height="12" fill="${p.primary}"/>
       <rect x="20" y="6" width="8" height="12" fill="${p.primary}"/>
       <rect x="6" y="8" width="20" height="18" fill="${p.primary}"/>
       <rect x="10" y="12" width="4" height="4" fill="${p.highlight}"/>
       <rect x="18" y="12" width="4" height="4" fill="${p.highlight}"/>
       <rect x="11" y="13" width="2" height="2" fill="${p.bg}"/>
       <rect x="19" y="13" width="2" height="2" fill="${p.bg}"/>
       <rect x="12" y="18" width="8" height="6" fill="${p.secondary}"/>
       <rect x="14" y="22" width="4" height="4" fill="${p.bg}"/>`,
      `<rect x="2" y="4" width="8" height="14" fill="${p.primary}"/>
       <rect x="22" y="4" width="8" height="14" fill="${p.primary}"/>
       <rect x="6" y="6" width="20" height="20" fill="${p.secondary}"/>
       <rect x="10" y="10" width="4" height="4" fill="${p.highlight}"/>
       <rect x="18" y="10" width="4" height="4" fill="${p.highlight}"/>
       <rect x="11" y="11" width="2" height="2" fill="${p.bg}"/>
       <rect x="19" y="11" width="2" height="2" fill="${p.bg}"/>
       <rect x="12" y="16" width="8" height="6" fill="${p.primary}"/>
       <rect x="14" y="18" width="4" height="2" fill="${p.bg}"/>`,
      `<rect x="6" y="8" width="20" height="18" fill="${p.primary}"/>
       <rect x="2" y="8" width="6" height="10" fill="${p.secondary}"/>
       <rect x="24" y="8" width="6" height="10" fill="${p.secondary}"/>
       <rect x="10" y="12" width="5" height="5" fill="${p.highlight}"/>
       <rect x="17" y="12" width="5" height="5" fill="${p.highlight}"/>
       <rect x="12" y="14" width="2" height="2" fill="${p.bg}"/>
       <rect x="19" y="14" width="2" height="2" fill="${p.bg}"/>
       <rect x="13" y="20" width="6" height="4" fill="${p.accent}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 4. 熊系列 (61-75)
  bear: (i, p) => {
    const variants = [
      `<rect x="4" y="2" width="8" height="8" fill="${p.primary}"/>
       <rect x="20" y="2" width="8" height="8" fill="${p.primary}"/>
       <rect x="6" y="4" width="4" height="4" fill="${p.secondary}"/>
       <rect x="22" y="4" width="4" height="4" fill="${p.secondary}"/>
       <rect x="4" y="8" width="24" height="20" fill="${p.primary}"/>
       <rect x="10" y="12" width="4" height="4" fill="${p.highlight}"/>
       <rect x="18" y="12" width="4" height="4" fill="${p.highlight}"/>
       <rect x="11" y="13" width="2" height="2" fill="${p.bg}"/>
       <rect x="19" y="13" width="2" height="2" fill="${p.bg}"/>
       <rect x="13" y="18" width="6" height="4" fill="${p.secondary}"/>
       <rect x="14" y="20" width="4" height="2" fill="${p.bg}"/>`,
      `<rect x="2" y="4" width="8" height="8" fill="${p.primary}"/>
       <rect x="22" y="4" width="8" height="8" fill="${p.primary}"/>
       <rect x="6" y="8" width="20" height="18" fill="${p.primary}"/>
       <rect x="8" y="14" width="6" height="6" fill="${p.highlight}"/>
       <rect x="18" y="14" width="6" height="6" fill="${p.highlight}"/>
       <rect x="10" y="16" width="2" height="2" fill="${p.bg}"/>
       <rect x="20" y="16" width="2" height="2" fill="${p.bg}"/>
       <rect x="12" y="22" width="8" height="4" fill="${p.secondary}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 5. 兔子系列 (76-90)
  rabbit: (i, p) => {
    const variants = [
      `<rect x="8" y="0" width="6" height="14" fill="${p.primary}"/>
       <rect x="18" y="0" width="6" height="14" fill="${p.primary}"/>
       <rect x="10" y="2" width="2" height="10" fill="${p.secondary}"/>
       <rect x="20" y="2" width="2" height="10" fill="${p.secondary}"/>
       <rect x="6" y="12" width="20" height="18" fill="${p.primary}"/>
       <rect x="10" y="16" width="4" height="4" fill="${p.highlight}"/>
       <rect x="18" y="16" width="4" height="4" fill="${p.highlight}"/>
       <rect x="11" y="17" width="2" height="2" fill="${p.accent}"/>
       <rect x="19" y="17" width="2" height="2" fill="${p.accent}"/>
       <rect x="14" y="22" width="4" height="3" fill="${p.secondary}"/>`,
      `<rect x="6" y="0" width="8" height="16" fill="${p.primary}"/>
       <rect x="18" y="0" width="8" height="16" fill="${p.primary}"/>
       <rect x="4" y="14" width="24" height="16" fill="${p.primary}"/>
       <rect x="9" y="18" width="5" height="5" fill="${p.highlight}"/>
       <rect x="18" y="18" width="5" height="5" fill="${p.highlight}"/>
       <rect x="11" y="20" width="2" height="2" fill="${p.bg}"/>
       <rect x="20" y="20" width="2" height="2" fill="${p.bg}"/>
       <rect x="14" y="24" width="4" height="2" fill="${p.secondary}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 6. 狐狸系列 (91-100)
  fox: (i, p) => {
    const variants = [
      `<rect x="2" y="4" width="8" height="10" fill="${p.primary}"/>
       <rect x="22" y="4" width="8" height="10" fill="${p.primary}"/>
       <rect x="4" y="6" width="4" height="6" fill="${p.secondary}"/>
       <rect x="24" y="6" width="4" height="6" fill="${p.secondary}"/>
       <rect x="6" y="10" width="20" height="18" fill="${p.primary}"/>
       <rect x="10" y="14" width="4" height="4" fill="${p.highlight}"/>
       <rect x="18" y="14" width="4" height="4" fill="${p.highlight}"/>
       <rect x="11" y="15" width="2" height="2" fill="${p.bg}"/>
       <rect x="19" y="15" width="2" height="2" fill="${p.bg}"/>
       <rect x="12" y="20" width="8" height="6" fill="${p.secondary}"/>
       <rect x="14" y="22" width="4" height="2" fill="${p.bg}"/>`,
      `<rect x="4" y="2" width="6" height="12" fill="${p.primary}"/>
       <rect x="22" y="2" width="6" height="12" fill="${p.primary}"/>
       <rect x="6" y="8" width="20" height="20" fill="${p.primary}"/>
       <rect x="8" y="10" width="6" height="8" fill="${p.secondary}"/>
       <rect x="18" y="10" width="6" height="8" fill="${p.secondary}"/>
       <rect x="10" y="12" width="3" height="3" fill="${p.highlight}"/>
       <rect x="19" y="12" width="3" height="3" fill="${p.highlight}"/>
       <rect x="13" y="20" width="6" height="6" fill="${p.secondary}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 7. 外星人系列 (101-115)
  alien: (i, p) => {
    const variants = [
      `<rect x="8" y="2" width="16" height="6" fill="${p.primary}"/>
       <rect x="4" y="6" width="24" height="18" fill="${p.primary}"/>
       <rect x="6" y="10" width="8" height="10" fill="${p.bg}"/>
       <rect x="18" y="10" width="8" height="10" fill="${p.bg}"/>
       <rect x="8" y="12" width="4" height="6" fill="${p.secondary}"/>
       <rect x="20" y="12" width="4" height="6" fill="${p.secondary}"/>
       <rect x="9" y="13" width="2" height="2" fill="${p.highlight}"/>
       <rect x="21" y="13" width="2" height="2" fill="${p.highlight}"/>
       <rect x="12" y="22" width="8" height="2" fill="${p.accent}"/>
       <rect x="10" y="0" width="2" height="4" fill="${p.accent}"/>
       <rect x="20" y="0" width="2" height="4" fill="${p.accent}"/>`,
      `<rect x="6" y="4" width="20" height="24" fill="${p.primary}"/>
       <rect x="4" y="8" width="4" height="12" fill="${p.primary}"/>
       <rect x="24" y="8" width="4" height="12" fill="${p.primary}"/>
       <rect x="8" y="8" width="6" height="8" fill="${p.secondary}"/>
       <rect x="18" y="8" width="6" height="8" fill="${p.secondary}"/>
       <rect x="10" y="10" width="2" height="4" fill="${p.highlight}"/>
       <rect x="20" y="10" width="2" height="4" fill="${p.highlight}"/>
       <rect x="10" y="20" width="12" height="4" fill="${p.accent}"/>`,
      `<rect x="4" y="6" width="24" height="20" fill="${p.primary}"/>
       <rect x="8" y="2" width="16" height="6" fill="${p.primary}"/>
       <rect x="6" y="10" width="10" height="8" fill="${p.bg}"/>
       <rect x="16" y="10" width="10" height="8" fill="${p.bg}"/>
       <rect x="8" y="12" width="6" height="4" fill="${p.accent}"/>
       <rect x="18" y="12" width="6" height="4" fill="${p.accent}"/>
       <rect x="14" y="22" width="4" height="4" fill="${p.secondary}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 8. 幽灵系列 (116-125)
  ghost: (i, p) => {
    const variants = [
      `<rect x="8" y="4" width="16" height="6" fill="${p.primary}"/>
       <rect x="6" y="8" width="20" height="16" fill="${p.primary}"/>
       <rect x="6" y="24" width="4" height="4" fill="${p.primary}"/>
       <rect x="14" y="24" width="4" height="4" fill="${p.primary}"/>
       <rect x="22" y="24" width="4" height="4" fill="${p.primary}"/>
       <rect x="10" y="12" width="4" height="4" fill="${p.bg}"/>
       <rect x="18" y="12" width="4" height="4" fill="${p.bg}"/>
       <rect x="12" y="18" width="8" height="3" fill="${p.bg}"/>`,
      `<rect x="6" y="2" width="20" height="24" fill="${p.primary}"/>
       <rect x="4" y="6" width="4" height="16" fill="${p.primary}"/>
       <rect x="24" y="6" width="4" height="16" fill="${p.primary}"/>
       <rect x="8" y="26" width="6" height="4" fill="${p.primary}"/>
       <rect x="18" y="26" width="6" height="4" fill="${p.primary}"/>
       <rect x="10" y="10" width="4" height="6" fill="${p.secondary}"/>
       <rect x="18" y="10" width="4" height="6" fill="${p.secondary}"/>
       <rect x="11" y="11" width="2" height="2" fill="${p.highlight}"/>
       <rect x="19" y="11" width="2" height="2" fill="${p.highlight}"/>
       <rect x="12" y="20" width="8" height="2" fill="${p.bg}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 9. 骷髅系列 (126-135)
  skull: (i, p) => {
    const variants = [
      `<rect x="6" y="4" width="20" height="6" fill="${p.primary}"/>
       <rect x="4" y="8" width="24" height="14" fill="${p.primary}"/>
       <rect x="6" y="22" width="20" height="4" fill="${p.primary}"/>
       <rect x="8" y="10" width="6" height="8" fill="${p.bg}"/>
       <rect x="18" y="10" width="6" height="8" fill="${p.bg}"/>
       <rect x="10" y="12" width="2" height="4" fill="${p.secondary}"/>
       <rect x="20" y="12" width="2" height="4" fill="${p.secondary}"/>
       <rect x="14" y="18" width="4" height="4" fill="${p.bg}"/>
       <rect x="10" y="24" width="2" height="4" fill="${p.primary}"/>
       <rect x="14" y="24" width="4" height="4" fill="${p.primary}"/>
       <rect x="20" y="24" width="2" height="4" fill="${p.primary}"/>`,
      `<rect x="4" y="6" width="24" height="18" fill="${p.primary}"/>
       <rect x="8" y="2" width="16" height="6" fill="${p.primary}"/>
       <rect x="6" y="10" width="8" height="8" fill="${p.bg}"/>
       <rect x="18" y="10" width="8" height="8" fill="${p.bg}"/>
       <rect x="8" y="12" width="4" height="4" fill="${p.accent}"/>
       <rect x="20" y="12" width="4" height="4" fill="${p.accent}"/>
       <rect x="14" y="18" width="4" height="6" fill="${p.bg}"/>
       <rect x="8" y="24" width="16" height="4" fill="${p.primary}"/>`,
    ];
    return variants[i % variants.length];
  },

  // 10. 食物-汉堡 (136-140)
  burger: (i, p) => {
    return `<rect x="4" y="6" width="24" height="6" fill="${p.primary}"/>
     <rect x="6" y="4" width="20" height="4" fill="${p.primary}"/>
     <rect x="8" y="6" width="2" height="2" fill="${p.highlight}"/>
     <rect x="14" y="5" width="2" height="2" fill="${p.highlight}"/>
     <rect x="20" y="7" width="2" height="2" fill="${p.highlight}"/>
     <rect x="2" y="12" width="28" height="4" fill="${p.secondary}"/>
     <rect x="4" y="16" width="24" height="4" fill="${p.accent}"/>
     <rect x="2" y="20" width="28" height="4" fill="#8B4513"/>
     <rect x="4" y="24" width="24" height="4" fill="${p.primary}"/>
     <rect x="6" y="26" width="20" height="2" fill="${p.primary}"/>`;
  },

  // 11. 食物-披萨 (141-145)
  pizza: (i, p) => {
    return `<rect x="4" y="4" width="24" height="24" fill="${p.primary}"/>
     <rect x="6" y="6" width="20" height="20" fill="${p.secondary}"/>
     <rect x="10" y="10" width="4" height="4" fill="${p.accent}"/>
     <rect x="18" y="8" width="4" height="4" fill="${p.accent}"/>
     <rect x="8" y="18" width="4" height="4" fill="${p.accent}"/>
     <rect x="16" y="16" width="4" height="4" fill="${p.accent}"/>
     <rect x="12" y="14" width="3" height="3" fill="#228B22"/>
     <rect x="20" y="18" width="3" height="3" fill="#228B22"/>`;
  },

  // 12. 食物-冰淇淋 (146-150)
  icecream: (i, p) => {
    return `<rect x="10" y="4" width="12" height="4" fill="${p.primary}"/>
     <rect x="8" y="6" width="16" height="8" fill="${p.primary}"/>
     <rect x="6" y="10" width="20" height="6" fill="${p.secondary}"/>
     <rect x="8" y="14" width="16" height="4" fill="${p.accent}"/>
     <rect x="12" y="6" width="2" height="2" fill="${p.highlight}"/>
     <rect x="18" y="8" width="2" height="2" fill="${p.highlight}"/>
     <rect x="12" y="18" width="8" height="4" fill="#D2691E"/>
     <rect x="13" y="22" width="6" height="4" fill="#D2691E"/>
     <rect x="14" y="26" width="4" height="4" fill="#D2691E"/>`;
  },

  // 13. 食物-寿司 (151-155)
  sushi: (i, p) => {
    return `<rect x="4" y="10" width="24" height="14" fill="${p.primary}"/>
     <rect x="6" y="8" width="20" height="4" fill="${p.secondary}"/>
     <rect x="8" y="6" width="16" height="4" fill="${p.accent}"/>
     <rect x="10" y="4" width="12" height="4" fill="${p.accent}"/>
     <rect x="2" y="14" width="4" height="6" fill="#1a1a1a"/>
     <rect x="26" y="14" width="4" height="6" fill="#1a1a1a"/>
     <rect x="12" y="8" width="2" height="2" fill="${p.highlight}"/>
     <rect x="18" y="7" width="2" height="2" fill="${p.highlight}"/>`;
  },

  // 14. 水果-苹果 (156-160)
  apple: (i, p) => {
    return `<rect x="14" y="2" width="4" height="4" fill="#8B4513"/>
     <rect x="18" y="4" width="4" height="4" fill="${p.secondary}"/>
     <rect x="10" y="6" width="12" height="4" fill="${p.primary}"/>
     <rect x="8" y="8" width="16" height="6" fill="${p.primary}"/>
     <rect x="6" y="12" width="20" height="10" fill="${p.primary}"/>
     <rect x="8" y="22" width="16" height="4" fill="${p.primary}"/>
     <rect x="10" y="26" width="12" height="2" fill="${p.primary}"/>
     <rect x="10" y="12" width="3" height="3" fill="${p.highlight}"/>`;
  },

  // 15. 几何-钻石 (161-165)
  diamond: (i, p) => {
    return `<rect x="12" y="4" width="8" height="4" fill="${p.secondary}"/>
     <rect x="8" y="8" width="16" height="4" fill="${p.primary}"/>
     <rect x="4" y="12" width="24" height="4" fill="${p.primary}"/>
     <rect x="6" y="16" width="20" height="4" fill="${p.secondary}"/>
     <rect x="8" y="20" width="16" height="4" fill="${p.primary}"/>
     <rect x="10" y="24" width="12" height="2" fill="${p.secondary}"/>
     <rect x="12" y="26" width="8" height="2" fill="${p.primary}"/>
     <rect x="14" y="28" width="4" height="2" fill="${p.secondary}"/>
     <rect x="12" y="12" width="4" height="4" fill="${p.highlight}"/>`;
  },

  // 16. 几何-星星 (166-170)
  star: (i, p) => {
    return `<rect x="14" y="2" width="4" height="6" fill="${p.primary}"/>
     <rect x="12" y="6" width="8" height="4" fill="${p.primary}"/>
     <rect x="2" y="10" width="28" height="6" fill="${p.primary}"/>
     <rect x="6" y="16" width="20" height="4" fill="${p.primary}"/>
     <rect x="8" y="20" width="6" height="6" fill="${p.primary}"/>
     <rect x="18" y="20" width="6" height="6" fill="${p.primary}"/>
     <rect x="6" y="26" width="4" height="4" fill="${p.primary}"/>
     <rect x="22" y="26" width="4" height="4" fill="${p.primary}"/>
     <rect x="14" y="10" width="4" height="4" fill="${p.highlight}"/>`;
  },

  // 17. 几何-心形 (171-175)
  heart: (i, p) => {
    return `<rect x="4" y="8" width="8" height="8" fill="${p.primary}"/>
     <rect x="20" y="8" width="8" height="8" fill="${p.primary}"/>
     <rect x="6" y="6" width="6" height="4" fill="${p.primary}"/>
     <rect x="20" y="6" width="6" height="4" fill="${p.primary}"/>
     <rect x="4" y="14" width="24" height="6" fill="${p.primary}"/>
     <rect x="6" y="20" width="20" height="4" fill="${p.primary}"/>
     <rect x="8" y="24" width="16" height="2" fill="${p.primary}"/>
     <rect x="10" y="26" width="12" height="2" fill="${p.primary}"/>
     <rect x="14" y="28" width="4" height="2" fill="${p.primary}"/>
     <rect x="8" y="10" width="3" height="3" fill="${p.highlight}"/>`;
  },

  // 18. 自然-太阳 (176-180)
  sun: (i, p) => {
    return `<rect x="14" y="0" width="4" height="6" fill="${p.primary}"/>
     <rect x="14" y="26" width="4" height="6" fill="${p.primary}"/>
     <rect x="0" y="14" width="6" height="4" fill="${p.primary}"/>
     <rect x="26" y="14" width="6" height="4" fill="${p.primary}"/>
     <rect x="4" y="4" width="4" height="4" fill="${p.primary}"/>
     <rect x="24" y="4" width="4" height="4" fill="${p.primary}"/>
     <rect x="4" y="24" width="4" height="4" fill="${p.primary}"/>
     <rect x="24" y="24" width="4" height="4" fill="${p.primary}"/>
     <rect x="10" y="10" width="12" height="12" fill="${p.secondary}"/>
     <rect x="8" y="12" width="16" height="8" fill="${p.secondary}"/>
     <rect x="12" y="8" width="8" height="16" fill="${p.secondary}"/>
     <rect x="12" y="12" width="4" height="4" fill="${p.highlight}"/>`;
  },

  // 19. 自然-月亮 (181-185)
  moon: (i, p) => {
    return `<rect x="10" y="4" width="12" height="4" fill="${p.primary}"/>
     <rect x="6" y="6" width="16" height="4" fill="${p.primary}"/>
     <rect x="4" y="10" width="16" height="12" fill="${p.primary}"/>
     <rect x="6" y="22" width="12" height="4" fill="${p.primary}"/>
     <rect x="10" y="24" width="8" height="4" fill="${p.primary}"/>
     <rect x="8" y="8" width="2" height="2" fill="${p.secondary}"/>
     <rect x="12" y="14" width="3" height="3" fill="${p.secondary}"/>
     <rect x="6" y="18" width="2" height="2" fill="${p.secondary}"/>
     <rect x="8" y="12" width="4" height="4" fill="${p.highlight}"/>`;
  },

  // 20. 自然-云 (186-190)
  cloud: (i, p) => {
    return `<rect x="8" y="8" width="8" height="6" fill="${p.primary}"/>
     <rect x="4" y="12" width="24" height="10" fill="${p.primary}"/>
     <rect x="18" y="6" width="8" height="8" fill="${p.primary}"/>
     <rect x="6" y="14" width="20" height="6" fill="${p.primary}"/>
     <rect x="10" y="10" width="4" height="4" fill="${p.highlight}"/>
     <rect x="20" y="8" width="4" height="4" fill="${p.highlight}"/>`;
  },

  // 21. 物品-游戏机 (191-195)
  gameboy: (i, p) => {
    return `<rect x="6" y="2" width="20" height="28" fill="${p.primary}"/>
     <rect x="8" y="4" width="16" height="12" fill="${p.bg}"/>
     <rect x="10" y="6" width="12" height="8" fill="${p.secondary}"/>
     <rect x="12" y="8" width="4" height="4" fill="${p.accent}"/>
     <rect x="8" y="18" width="4" height="4" fill="${p.secondary}"/>
     <rect x="10" y="20" width="4" height="4" fill="${p.secondary}"/>
     <rect x="6" y="22" width="4" height="4" fill="${p.secondary}"/>
     <rect x="12" y="24" width="4" height="4" fill="${p.secondary}"/>
     <rect x="20" y="20" width="4" height="4" fill="${p.accent}"/>
     <rect x="18" y="24" width="3" height="3" fill="${p.accent}"/>`;
  },

  // 22. 物品-灯泡 (196-200)
  bulb: (i, p) => {
    return `<rect x="10" y="2" width="12" height="4" fill="${p.primary}"/>
     <rect x="8" y="4" width="16" height="6" fill="${p.primary}"/>
     <rect x="6" y="8" width="20" height="10" fill="${p.primary}"/>
     <rect x="8" y="18" width="16" height="4" fill="${p.primary}"/>
     <rect x="10" y="22" width="12" height="2" fill="${p.secondary}"/>
     <rect x="10" y="24" width="12" height="2" fill="${p.bg}"/>
     <rect x="10" y="26" width="12" height="2" fill="${p.secondary}"/>
     <rect x="10" y="28" width="12" height="2" fill="${p.bg}"/>
     <rect x="12" y="8" width="4" height="6" fill="${p.highlight}"/>
     <rect x="10" y="10" width="2" height="2" fill="${p.highlight}"/>`;
  },
};

// 主生成逻辑
function generateAvatar(index) {
  const palette = getPalette(index);

  // 根据索引选择生成器
  let content;
  if (index < 25) {
    content = generators.robot(index, palette);
  } else if (index < 45) {
    content = generators.cat(index - 25, palette);
  } else if (index < 60) {
    content = generators.dog(index - 45, palette);
  } else if (index < 75) {
    content = generators.bear(index - 60, palette);
  } else if (index < 90) {
    content = generators.rabbit(index - 75, palette);
  } else if (index < 100) {
    content = generators.fox(index - 90, palette);
  } else if (index < 115) {
    content = generators.alien(index - 100, palette);
  } else if (index < 125) {
    content = generators.ghost(index - 115, palette);
  } else if (index < 135) {
    content = generators.skull(index - 125, palette);
  } else if (index < 140) {
    content = generators.burger(index - 135, palette);
  } else if (index < 145) {
    content = generators.pizza(index - 140, palette);
  } else if (index < 150) {
    content = generators.icecream(index - 145, palette);
  } else if (index < 155) {
    content = generators.sushi(index - 150, palette);
  } else if (index < 160) {
    content = generators.apple(index - 155, palette);
  } else if (index < 165) {
    content = generators.diamond(index - 160, palette);
  } else if (index < 170) {
    content = generators.star(index - 165, palette);
  } else if (index < 175) {
    content = generators.heart(index - 170, palette);
  } else if (index < 180) {
    content = generators.sun(index - 175, palette);
  } else if (index < 185) {
    content = generators.moon(index - 180, palette);
  } else if (index < 190) {
    content = generators.cloud(index - 185, palette);
  } else if (index < 195) {
    content = generators.gameboy(index - 190, palette);
  } else {
    content = generators.bulb(index - 195, palette);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${palette.bg}"/>
  ${content}
</svg>`;
}

// 生成200个头像
console.log('Generating 200 avatars...');
for (let i = 0; i < 200; i++) {
  const svg = generateAvatar(i);
  const filename = `avatar_${String(i + 1).padStart(3, '0')}.svg`;
  fs.writeFileSync(path.join(outputDir, filename), svg);
  if ((i + 1) % 20 === 0) {
    console.log(`Generated ${i + 1}/200 avatars`);
  }
}

// 删除旧的单独头像文件
const oldFiles = ['robot.svg', 'cat.svg', 'alien.svg', 'skull.svg', 'fish.svg'];
oldFiles.forEach(f => {
  const p = path.join(outputDir, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

console.log('Done! 200 avatars generated in public/avatars/');
