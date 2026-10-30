# PC 入口云端语音情感识别

顶部统一为“采集录制 / 盲审复核 / 云端情感识别”三个页签。云端页签独立配置推理地址、模型、Key 和 RMS 音量门槛。

点击开始后循环：无限等待开口 → 录制讲话 → 停顿 600ms 后上传识别 → 显示结果 → 返回监听。没有静音切片，不上传空闲片段。每段讲话最多 15 秒；上传及推理期间暂停监听，不排队录制。按停止结束；离开网页也会停止。已发出的云端请求最多等待 60 秒结束，其结果不再显示，结束前不能启动下一次检测，以免请求重叠。

原有数据集采集和复核不变。云端检测与数据集录制互斥，请先停止当前功能再切换。云端音视频临时文件在推理后自动删除，不上传到 9004 数据集服务。

## 启动

在原 collector 环境安装新增依赖：

```shell
python -m pip install -r requirements-mer.txt
python collector_v2.py
```

打开 `http://localhost:8088`。默认推理地址为 demo 的 `http://183.62.69.210:9005/v1`、模型 `/data2/lzh/emo/checkpoint`。可在云端页签填写配置，或使用 `--mer-api-base`、`--mer-api-key`、`--mer-model`；支持 OPENAI_BASE_URL / OPENAI_API_KEY 环境变量。Key 输入留空会沿用启动配置，状态 API 不返回 Key。

**本目录虽然名为 PC，但原实现仍读取 RTSP 摄像头与 ROS `/rkaudio_asr_raw` 音频，本次保留这些来源，没有改为电脑本地麦克风。** 沿用原 `--rtsp`、`--ros-topic`、`--cam-api` 等参数。ROS 需持续提供 16kHz 单声道 int16 PCM；静音时也应有音频数据，超过两秒断流会停止报错。

使用 `start_collector.sh` 时，会从脚本所在目录启动 collector；其中的中间件和 conda 环境仍需符合原部署环境。硬件与真实云端服务需在运行设备上联调。

上传令牌使用 `--password` 或 `UPLOAD_TOKEN` 环境变量；云端 API Key 使用页面配置、`--mer-api-key` 或 `OPENAI_API_KEY`。源码不内置凭据，首次部署需自行配置。
