#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_art.py — 把「审美积累」板块的精选名作下载到本地文件夹。

用法（在你自己的电脑、有网的环境里运行）：
    cd draftgen
    python scripts/fetch_art.py

下载结果：
    draftgen/static/art-collection/<id>.jpg

App 会优先读取这些本地图（static/art-collection/），离线也能随时调取。
如某个文件名在 Wikimedia 上已变更导致 404，脚本会报告出来，你只需修正 ART 列表里
对应的 wm 字段即可。
"""
import os
import ssl
import urllib.request
import urllib.parse

# 与 index.html 中 aestheticCollection 保持一致
ART = [
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

WIDTH = 1200
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "draftgen", "static", "art-collection")
OUT_DIR = os.path.abspath(OUT_DIR)
UA = {"User-Agent": "DraftGenArtFetcher/1.0 (educational use; contact: user@example.com)"}

# 允许 SSL（部分环境根证书不全）
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def fetch_one(aid, wm):
    url = ("https://commons.wikimedia.org/wiki/Special:FilePath/"
           + urllib.parse.quote(wm) + "?width=" + str(WIDTH))
    dest = os.path.join(OUT_DIR, aid + ".jpg")
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return "skip"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
        data = r.read()
    if len(data) < 1000:
        return "empty"
    with open(dest, "wb") as f:
        f.write(data)
    return "ok"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ok = skip = fail = 0
    print(f"输出目录: {OUT_DIR}\n")
    for aid, wm in ART:
        try:
            st = fetch_one(aid, wm)
        except Exception as e:
            st = "fail:" + str(e)[:80]
        if st == "ok":
            ok += 1; mark = "✓ 下载"
        elif st == "skip":
            skip += 1; mark = "· 已存在"
        elif st == "empty":
            fail += 1; mark = "✗ 文件过小(可能404)"
        else:
            fail += 1; mark = "✗ " + st
        print(f"  [{mark}] {aid}")
    print(f"\n完成：新增 {ok} / 跳过 {skip} / 失败 {fail}（共 {len(ART)}）")
    if fail:
        print("失败的条目请检查上方 wm 文件名是否正确（Wikimedia 文件名变更所致）。")


if __name__ == "__main__":
    main()
