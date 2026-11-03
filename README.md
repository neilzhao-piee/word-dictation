# 听写小助手 · Word Dictation Helper

家庭自助的英语单词听写工具：家长拍单词表 → 视觉大模型识别单词 → 家长核对 → 浏览器 TTS（澳洲英语口音）逐词朗读 → 孩子写 → 家长拍答卷 → 自动判分、错题复习池、按 ISO 周的历史统计。

界面是中文，朗读是英文。手机浏览器直接用（免安装登录），也可以“添加到主屏幕”当 PWA 用。

A self-hosted helper for weekly school spelling tests. Photos go through an OpenAI-compatible vision model for OCR and handwriting grading; dictation audio is generated in the browser with the device's own Australian-English TTS voice.

## 流程 / Flow

1. **拍照单词表** — 打印或手写的每周拼写表，上传后视觉模型给出单词草稿。
2. **家长核对** — 草稿必须以词条（chips）形式人工确认/增删后才能开始，识别错误在源头被拦下。复习池里的旧错词会自动给出“建议加入”提示。
3. **逐词听写** — 浏览器 TTS 每次只读一个词，读完等家长点“下一个”才读下一个；朗读界面**不显示单词文本**，可中断可续。语速 0.85，另有慢速 0.55 重读。
4. **拍答卷判分** — 视觉模型只做识别，**对错由后端重新计算**（lowercase 归一 + 近似匹配），防止模型“好心”自动纠正孩子的错误拼写。写错的原样保留。
5. **复习池** — 写错/漏写的词自动进池（记次数）；下次听写核对页建议加入；写对一次自动毕业出池；也可在“复习池”页手动移除。
6. **历史与统计** — 按 ISO 周（周一开始，`Australia/Perth`）分组的成绩、错词数、平均分。

## 快速开始 / Quick start

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/uvicorn app:app --host 0.0.0.0 --port 8090
```

手机连同一个 Wi-Fi，打开 `http://<主机IP>:8090`。无需任何账号密码。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WD_VISION_URL` | `http://127.0.0.1:8080/v1/chat/completions` | 任何 OpenAI 兼容的**视觉**端点（本地 vLLM / llama.cpp server / 云端 API 均可） |
| `WD_VISION_MODEL` | `qwen3.8-flash-next-iq3_xxs` | 端点里的视觉模型名 |
| `WD_VISION_TIMEOUT` | `300` | 单次视觉调用超时（秒） |
| `WD_DATA_DIR` | `./data` | SQLite 数据库与照片存储目录 |

注意：应用本身不提供认证，**设计用途是家庭局域网内使用**；不要把它直接暴露到公网。

## 生产部署（systemd 示例）

见 [`deploy/setup.sh.example`](deploy/setup.sh.example) 与 [`deploy/worddict.service.example`](deploy/worddict.service.example)：装到 `/opt/word-dictation`，以专用用户跑 uvicorn，`Restart=always`。数据库表在启动时自动创建（`CREATE TABLE IF NOT EXISTS`），升级只需替换代码后重启。

## 技术构成

- 后端：FastAPI + SQLite，Python 3.12+（无其它依赖）
- 前端：原生 JS 单页应用，hash 路由，无构建步骤；`manifest.webmanifest` 支持添加到主屏幕
- 判分防御：`difflib` 近似匹配兜底；“漏写”单独统计
- 上传的图片在客户端压缩（>900KB 时 canvas 压到 1600px JPEG）

## 测试数据

`testdata/` 里有三张合成样张（单词表、部分错误的答卷、全对答卷）和 `vision_test.py`（直接探测视觉端点的小工具），可用来跑通一次端到端流程。

## License

MIT
