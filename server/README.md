# 多模态情感数据采集标注系统 - 中心服务端

本服务为纯后端 RESTful API 节点，负责接收边缘端（如机器人、开发板）采集上传的多模态数据（音视频及元数据），并提供样本查询、并发锁定、复核提交等接口支持。

---

## 目录结构

```text
app.log                    #服务日志，每固定3小时更新一次，保留最新2万条
pid.txt                    #服务运行的pid 
更新日志.md                 # 更新日志
server/
├── config.py              # 配置中心（路径、密码、TTL）
├── services/
│   ├── __init__.py
│   ├── auth.py            # Token 鉴权中间件
│   └── storage.py         # 样本存储操作与内存排他锁
├── routes/
│   ├── __init__.py
│   ├── samples.py         # 采集上传及静态媒体路由
│   └── review.py          # 样本复核流转路由
├── app.py                 # 服务入口
└── data_emo/              # 数据持久化目录（自动生成）
│ 
└── data_emo_invalid/      # 无效数据暂存，可以清理

ps -p 2237304 查询pid
ps -p 2237304 -o etime 存活时间
crontab -e 编辑定时任务