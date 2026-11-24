# AndroidPanelTool Web (在线版)

[![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-Online-brightgreen.svg)](https://veizhang.github.io/AndroidPanelTool-Web/)
[![Pure Client-Side](https://img.shields.io/badge/Security-Pure_Client_Side-blue.svg)](#)
[![No Cloud Upload](https://img.shields.io/badge/Data_Privacy-100%25_Local_Memory-orange.svg)](#)

👉 **[点击直接在浏览器中打开使用 AndroidPanelTool Web](https://veizhang.github.io/AndroidPanelTool-Web/)**

**AndroidPanelTool Web** 是专为 Android 大屏商显屏参配置与产线升级包管理打造的**纯前端免安装在线工具**。

---

## 🌟 核心特性

- **纯前端内存运行，零数据上传**：
  基于 HTML5 File API + JSZip + SparkMD5，所有 ZIP 解压、属性解析修改、MD5 计算与重新打包生成**全部在用户本地浏览器内存中完成**，绝不往任何云端服务器传输数据，确保固件配置绝对私密与安全。
- **即开即用**：
  无需下载任何客户端，任何设备（Windows / Mac / Linux / 移动平板）使用现代浏览器（Edge / Chrome / Firefox / Safari）打开即可直接使用。
- **全模块可视化编辑**：
  - ① 安卓系统属性 (`build.prop`)：属性搜索、修改、增删与核心属性防呆校验；
  - ② 画质色温与 EDID (`db.ini`)：EDID 模式切换、RGB 白平衡增益参数调节；
  - ③ 开机媒体资源 (`logo.img` / `bootanimation.zip`) 格式与大小校验；
  - ④ 分屏模式开关 (`singleMode.txt`)：单屏/分屏一键切换（严格保障 Linux LF 换行）；
  - ⑤ 屏参元数据 (`hht_panel_cfg.ini`) 快速维护与识别码绑定。
- **产线双层 ZIP 规范打包**：
  - 自动重新生成内层 `PanelFiles.zip` 与对应小写 MD5 校验文件 `PanelFiles.md5`；
  - 自动打包为带时间戳的外层升级包并直接触发浏览器本地下载。

---

## 📄 版权与维护

- **开发与维护**：[VeiZhang](https://github.com/VeiZhang)
- **桌面版客户端**：若需使用更强大的 VS Code 外部文件联动热重载与 ADB 设备在线比对功能，请访问桌面端私有工程。
