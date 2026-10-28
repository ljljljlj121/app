#!/bin/bash
# 罗比特板子端启动脚本
# 用法: bash start_collector.sh
# SSH 端口转发: ssh -L 8088:127.0.0.1:8088 <user>@<board_ip>
# 然后浏览器打开: http://localhost:8088

set -e

echo "======================================"
echo "  情感采集系统 - 板子端启动"
echo "======================================"


# 1. 精确清理旧进程与释放 8081 端口（避免误杀 start_collector.sh 自身）
echo "[1/4] 清理旧进程并启动 ROS 中间件..."
sudo fuser -k 8081/tcp >/dev/null 2>&1 || true
pkill -9 -f "python.*collector.*\.py" 2>/dev/null || true
pkill -9 -f "nav_middleware_bridge" 2>/dev/null || true
sleep 1

# 启动中间件
cd /userdata/app/nav_middleware_bridge
bash ./run.sh &
ROS_PID=$!
echo "      ROS 中间件 PID: $ROS_PID"
echo "      正在等待中间件加载模型与相机服务 (30 秒)..."
sleep 31

# 2. 切换工作目录
echo "[2/4] 切换到工作目录..."
cd /userdata/app/RobotAiClient/src/emo/data_collection

# 3. 设置环境变量
echo "[3/4] 设置环境变量..."
export LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libgomp.so.1

# 4. 启动 collector
echo "[4/4] 启动采集程序..."
echo ""
echo "  SSH 端口转发命令（在本机运行）:"
echo "    ssh -L 8088:127.0.0.1:8088 <用户名>@<板子IP>"
echo "  然后浏览器打开: http://localhost:8088"
echo ""

conda run -n env_310 python collector_v2.py "$@"