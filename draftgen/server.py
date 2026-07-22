"""DraftGen Backend Server - FastAPI with DeepSeek API proxy"""
import os
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="DraftGen Server")

class DeepSeekRequest(BaseModel):
    api_key: str
    api_endpoint: str = "https://api.deepseek.com"
    model: str = "deepseek-chat"
    mode: str = "composition"
    user_input: str = ""
    canvas_info: str = ""

@app.post("/api/deepseek")
async def deepseek_proxy(req: DeepSeekRequest):
    if not req.api_key:
        raise HTTPException(status_code=400, detail="API Key is required")
    
    mode_prompts = {
        "composition": (
            "你是一个专业的绘画构图顾问。根据用户的描述，提供详细的构图建议，包括：\n"
            "1. 推荐的构图类型（三分法、黄金螺旋、对称等）\n"
            "2. 主体位置和大小建议\n"
            "3. 前景/中景/远景的安排\n"
            "4. 视线引导和视觉平衡\n"
            "5. 具体的画面分割建议\n请用简洁清晰的格式回答。"
        ),
        "prompt": (
            "你是一个专业的AI绘画提示词专家。根据用户的描述，生成高质量的绘画提示词，包括：\n"
            "1. 主体描述\n2. 风格关键词\n3. 光线和氛围\n4. 色彩倾向\n5. 技法和细节\n请提供中英文双语版本。"
        ),
        "comprehensive": (
            "你是一个综合性的绘画指导顾问。根据用户的描述，提供全面的绘画指导，包括：\n"
            "1. 构图建议\n2. 色彩方案\n3. 绘画步骤建议\n4. 技法提示\n5. 参考风格推荐\n请用结构化格式回答。"
        )
    }
    
    system_prompt = mode_prompts.get(req.mode, mode_prompts["composition"])
    user_message = req.user_input
    if req.canvas_info:
        user_message += f"\n\n画布信息：{req.canvas_info}"
    
    payload = {
        "model": req.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ],
        "temperature": 0.7,
        "max_tokens": 2000
    }
    
    url = f"{req.api_endpoint.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {req.api_key}",
        "Content-Type": "application/json"
    }
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)
            return response.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="DeepSeek API request timed out")
    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail="Cannot connect to DeepSeek API")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
async def index():
    return FileResponse("./draftgen/static/index.html")

app.mount("/static", StaticFiles(directory="./draftgen/static"), name="static")

@app.get("/ping")
async def ping():
    return {"status": "alive"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
