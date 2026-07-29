"""DraftGen Backend Server - FastAPI with DeepSeek API proxy"""
import os
import re
import asyncio
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="DraftGen Server")

# ---- 美术馆·名作图片预下载（部署/启动时自动补齐 static/art-collection，避免依赖被墙的外部图源）----
import time
import urllib.parse
import threading
from concurrent.futures import ThreadPoolExecutor

# (id, Wikimedia 文件名) —— 与 index.html 中 aestheticCollection 的 wm 字段保持一致
ART_COLLECTION = [
    ("mona-lisa", "Mona_Lisa,_by_Leonardo_da_Vinci,_from_C2RMF_retouched.jpg"),
    ("birth-of-venus", "Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg"),
    ("school-of-athens", "Raffael_058.jpg"),
    ("sistine-madonna", "Sistine_Madonna_(original)_FXD.jpg"),
    ("creation-adam", "Michelangelo_-_Creation_of_Adam_(cropped).jpg"),
    ("arnolfini", "Van_Eyck_-_Arnolfini_Portrait.jpg"),
    ("garden-delights", "The_Garden_of_earthly_delights.jpg"),
    ("tower-babel", "Pieter_Bruegel_the_Elder_-_The_Tower_of_Babel_(Vienna)_-_Google_Art_Project_-_edited.jpg"),
    ("durer-self", "Albrecht_Dürer_-_1500_self-portrait_(High_resolution_and_detail).jpg"),
    ("melencolia", "Albrecht_Dürer_-_Melencolia_I_-_Google_Art_Project_(427760).jpg"),
    ("night-watch", "Rembrandt_van_Rijn-De_Nachtwacht-1642.jpg"),
    ("rembrandt-self", "Rembrandt_van_Rijn_-_Self-Portrait_-_Google_Art_Project.jpg"),
    ("las-meninas", "Las_Meninas,_by_Diego_Velázquez,_from_Prado_in_Google_Earth.jpg"),
    ("girl-pearl", "1665_Girl_with_a_Pearl_Earring.jpg"),
    ("liberty", "Eugène_Delacroix_-_La_liberté_guidant_le_peuple.jpg"),
    ("wanderer-fog", "Caspar_David_Friedrich_-_Wanderer_above_the_sea_of_fog.jpg"),
    ("third-may", "El_Tres_de_Mayo,_by_Francisco_de_Goya,_from_Prado_in_Google_Earth.jpg"),
    ("hay-wain", "John_Constable_The_Hay_Wain.jpg"),
    ("fighting-temeraire", "The_Fighting_Temeraire,_JMW_Turner,_National_Gallery.jpg"),
    ("ophelia", "John_Everett_Millais_-_Ophelia_-_Google_Art_Project.jpg"),
    ("impression-sunrise", "Monet_-_Impression,_Sunrise.jpg"),
    ("water-lilies", "Claude_Monet_-_Water_Lilies_-_1906,_Ryerson.jpg"),
    ("starry-night", "Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg"),
    ("sunflowers", "Vincent_Willem_van_Gogh_127.jpg"),
    ("moulin-rouge", "Henri_de_Toulouse-Lautrec_-_At_the_Moulin_Rouge_-_Google_Art_Project.jpg"),
    ("kiss-klimt", "The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg"),
    ("scream", "Edvard_Munch,_1893,_The_Scream,_oil,_tempera_and_pastel_on_cardboard,_91_x_73_cm,_National_Gallery_of_Norway.jpg"),
    ("schiele-self", "Egon_Schiele_-_Self-Portrait_with_Lowered_Head_-_Google_Art_Project.jpg"),
    ("persistence-memory", "The_Persistence_of_Memory.jpg"),
    ("american-gothic", "Grant_Wood_-_American_Gothic_-_Google_Art_Project.jpg"),
    ("sleeping-gypsy", "La_Bohémienne_endormie.jpg"),
    ("mondrian-comp", "Composition-with-red-yellow-and-blue.jpg"),
    ("black-square", "Malevich.black-square.jpg"),
    ("whistler-mother", "Whistlers_Mother_high_res.jpg"),
    ("olympia", "Edouard_Manet_-_Olympia_-_Google_Art_Project_3.jpg"),
    ("great-wave", "Tsunami_by_hokusai_19th_century.jpg"),
    ("vitruvian", "Da_Vinci_Vitruve_Luc_Viatour.jpg"),
    ("libyan-sibyl", "LibyanSibyl_SistineChapel.jpg"),
    ("anatomical-shoulder", "Leonardo_da_Vinci_-_Anatomical_studies_of_the_shoulder_-_WGA12824.jpg"),
    ("study-hands", "Leonardo_da_Vinci_-_Study_of_hands_-_WGA12812.jpg"),
    ("draftsman-nude", "Dürer_-_Zeichner_und_Akt.jpg"),
    ("woman-toilette", "Degas_-_Woman-At-Her-Toilette-I.jpg"),
    ("rembrandt-draw", "Rembrandt_van_Rijn,_Self-Portrait_Drawing_at_a_Window,_1648,_NGA_9930.jpg"),
    ("hokusai-manga", "Manga_Hokusai.jpg"),
]

def _download_art_one(aid, wm):
    base = os.path.join(os.path.dirname(__file__), "static", "art-collection")
    os.makedirs(base, exist_ok=True)
    dest = os.path.join(base, aid + ".jpg")
    try:
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            return "skip"
        url = ("https://commons.wikimedia.org/wiki/Special:FilePath/"
               + urllib.parse.quote(wm) + "?width=800")
        last_err = ""
        for attempt in range(4):
            try:
                with httpx.Client(follow_redirects=True, timeout=60) as client:
                    r = client.get(url, headers={"User-Agent": "DraftGen/1.0 (art prefetch)"})
                if r.status_code == 200 and len(r.content) > 1000:
                    with open(dest, "wb") as f:
                        f.write(r.content)
                    return "ok"
                if r.status_code in (429, 500, 502, 503, 504):
                    last_err = "HTTP %d" % r.status_code
                    time.sleep(2 * (attempt + 1))
                    continue
                last_err = "HTTP %d" % r.status_code
                break
            except Exception as e:
                last_err = str(e)[:60]
                time.sleep(2 * (attempt + 1))
        return "fail:" + last_err
    except Exception as e:
        return "fail:" + str(e)[:60]


def prefetch_art_collection():
    results = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for res in ex.map(lambda p: (p[0], _download_art_one(*p)), ART_COLLECTION):
            results[res[0]] = res[1]
    ok = sum(1 for v in results.values() if v == "ok")
    skip = sum(1 for v in results.values() if v == "skip")
    fails = [(k, v) for k, v in results.items() if not v.startswith(("ok", "skip"))]
    print("[art-prefetch] 完成：新增 %d / 跳过 %d / 失败 %d" % (ok, skip, len(fails)))
    for k, v in fails:
        print("[art-prefetch] 失败 %s -> %s" % (k, v))

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

# 名作图片按需代理：文件不存在时实时从 Wikimedia 拉取并缓存到本地。
# 由 Render 服务端代取，规避国内 GFW 对维基的封锁；尊重 429 的 Retry-After 退避重试，
# 并在 Special:FilePath 双源（Commons / en.wikipedia）失效时回退到 imageinfo 规范 URL。
# 个别超大原图在 Wikimedia 的 Special:FilePath?width= 缩略图会因新版权限/体积限制而 404：
# 丢勒自画像取 Wikimedia 原图直链（非 /thumb/ 路径，不受缩略图限制）；
# 宫娥(266MB)/忧郁症(17.9MB)改取 Web Gallery of Art 直链（小图、无缩略图限制）。
_WM_ALT = {
    "durer-self": "https://upload.wikimedia.org/wikipedia/commons/d/dc/Albrecht_D%C3%BCrer_-_1500_self-portrait_%28High_resolution_and_detail%29.jpg",
    "melencolia": "https://www.wga.hu/art/d/durer/2/13/4/079.jpg",
    "las-meninas": "https://www.wga.hu/art/v/velazque/08/0804vela.jpg",
}
_WM_MAP = dict(ART_COLLECTION)
ART_SEM = asyncio.Semaphore(2)

async def _wm_fetch(wm: str, aid: str = None):
    """拉取名作图片字节；成功返回 bytes，失败返回 None。"""
    ua = {"User-Agent": "DraftGen/1.0 (art prefetch)"}
    # 1) 直链回退（超大/受限图）—— WGA 等站会拦截机器人 UA，故用浏览器 UA
    alt = _WM_ALT.get(aid) if aid else None
    if alt:
        browser_ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                                   "Chrome/120.0 Safari/537.36"}
        for attempt in range(4):
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=120) as client:
                    r = await client.get(alt, headers=browser_ua)
                if r.status_code == 200 and len(r.content) > 1000:
                    return r.content
            except Exception:
                pass
            await asyncio.sleep(2 * (attempt + 1))
    # 2) Wikimedia Special:FilePath 双源（Commons / en.wikipedia）
    bases = (
        "https://commons.wikimedia.org/wiki/Special:FilePath/",
        "https://en.wikipedia.org/wiki/Special:FilePath/",
    )
    last = None
    for attempt in range(8):
        retried = False
        for base in bases:
            try:
                async with ART_SEM:
                    async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
                        r = await client.get(
                            base + urllib.parse.quote(wm) + "?width=800", headers=ua)
                if r.status_code == 200 and len(r.content) > 1000:
                    return r.content
                last = r.status_code
                if r.status_code == 429:
                    ra = r.headers.get("Retry-After")
                    try:
                        wait = min(int(float(ra)), 60)
                    except (TypeError, ValueError):
                        wait = 4 * (attempt + 1)
                    await asyncio.sleep(wait)
                    retried = True
                    continue
                if r.status_code in (500, 502, 503, 504):
                    await asyncio.sleep(3 * (attempt + 1))
                    retried = True
                    continue
            except Exception as e:
                last = str(e)[:40]
                await asyncio.sleep(2 * (attempt + 1))
                retried = True
        if not retried:  # 两源都确定性失败（如 404 文件名错），不再重试
            break
    # 3) 回退：用 imageinfo 取规范 upload URL（原图）再拉一次
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=120) as client:
            api = ("https://commons.wikimedia.org/w/api.php?action=query&format=json"
                   "&prop=imageinfo&iiprop=url&titles=File:" + urllib.parse.quote(wm))
            r = await client.get(api, headers=ua)
            if r.status_code == 200:
                pages = r.json().get("query", {}).get("pages", {})
                for p in pages.values():
                    ii = p.get("imageinfo")
                    if ii:
                        url = ii[0]["url"]
                        rr = await client.get(url, headers=ua)
                        if rr.status_code == 200 and len(rr.content) > 1000:
                            return rr.content
    except Exception as e:
        print("[art-proxy] imageinfo fallback error:", e)
    print("[art-proxy] fetch failed for", wm, "last=", last)
    return None

@app.get("/static/art-collection/{filename}")
async def art_collection_proxy(filename: str):
    if not re.match(r"^[a-z0-9-]+\.jpg$", filename):
        raise HTTPException(status_code=404, detail="not found")
    base = os.path.join(os.path.dirname(__file__), "static", "art-collection")
    os.makedirs(base, exist_ok=True)
    dest = os.path.join(base, filename)
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return FileResponse(dest, media_type="image/jpeg")
    aid = filename[:-4]
    wm = _WM_MAP.get(aid)
    if not wm:
        raise HTTPException(status_code=404, detail="not found")
    data = await _wm_fetch(wm, aid)
    if data:
        with open(dest, "wb") as f:
            f.write(data)
        return Response(data, media_type="image/jpeg")
    raise HTTPException(status_code=404, detail="fetch failed")

app.mount("/static", StaticFiles(directory="./draftgen/static"), name="static")

@app.get("/ping")
async def ping():
    return {"status": "alive"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
