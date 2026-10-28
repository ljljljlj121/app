#!/usr/bin/env python3
"""
多模态情感数据采集标注系统 - 纯后端中心服务
"""

from flask import Flask
from routes.samples import samples_bp
from routes.review import review_bp

def create_app() -> Flask:
    app = Flask(__name__)
    
    # 注册解耦出的路由模块
    app.register_blueprint(samples_bp)
    app.register_blueprint(review_bp)
    
    return app

if __name__ == "__main__":
    app = create_app()
    # 保持与 collector.py 默认配置一致的端口 (9001)
    app.run(host="0.0.0.0", port=9004, debug=False, threaded=True)