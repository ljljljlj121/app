from functools import wraps
from flask import jsonify, request
from config import PASSWORD

def require_token(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("X-Upload-Token", "")
        if token != PASSWORD:
            return jsonify({"ok": False, "msg": "未授权或 Token 错误"}), 403
        return f(*args, **kwargs)
    return decorated