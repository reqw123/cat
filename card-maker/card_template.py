# 圖片一鍵生成卡片用的 HTML 模板。由 cards/dog_cards/build/template.py 複製而來（六狗系列的
# 架構：自由 360° 環轉、卡背、每秒自動翻面、按 L / 桌面掛件 F4），卡背改成跟
# 六狗最新版一致的「徽章環 + 屬性晶片 + 編號」樣式，並新增 %%RARITY%%。
TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>%%PAGE_TITLE%%</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700;900&family=Noto+Sans+TC:wght@400;500;700;900&display=swap" rel="stylesheet" />
<style>
  @property --holo-ang { syntax:'<angle>'; inherits:true; initial-value:%%HOLO_ANG0%%deg; }

  :root{
    --c1:%%C1%%;
    --c2:%%C2%%;
    --c3:%%C3%%;
    --abyss:%%ABYSS%%;
    --frame:6px;
    --card-w: clamp(272px, min(86vw, 58vh), 372px);
  }
  *,*::before,*::after{ box-sizing:border-box; margin:0; padding:0; }
  img{ -webkit-user-drag:none; user-select:none; -webkit-user-select:none; }
  html,body{ height:100%; }
  body{
    background:radial-gradient(130% 120% at 50% -10%, %%BODY_BG1%% 0%, %%BODY_BG2%% 38%, %%BODY_BG3%% 72%, %%BODY_BG4%% 100%);
    color:#eef5f2;
    font-family:'Noto Sans TC', system-ui, -apple-system, "Microsoft JhengHei", "PingFang TC", sans-serif;
    display:grid; place-items:center; overflow:hidden;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
    touch-action:none;
  }
  .card, .card *{
    -webkit-user-select:none; user-select:none;
    -webkit-touch-callout:none;
  }
  body::before{
    content:""; position:fixed; inset:-20%;
    background:
      radial-gradient(2px 2px at 20% 30%, %%DUST1%%, transparent 60%),
      radial-gradient(2px 2px at 78% 22%, %%DUST2%%, transparent 60%),
      radial-gradient(1.5px 1.5px at 62% 68%, rgba(255,255,255,.25), transparent 60%),
      radial-gradient(1.5px 1.5px at 33% 82%, %%DUST3%%, transparent 60%);
    filter:blur(.3px);
    animation:floatDust 22s ease-in-out infinite alternate; pointer-events:none;
  }
  @keyframes floatDust{ to{ transform:translate3d(2%,-3%,0) rotate(3deg); } }

  .stage{
    perspective:1300px;
    perspective-origin:50% 42%;
    display:flex; flex-direction:column; align-items:center; gap:14px;
    padding:60px 22px 26px;
  }

  /* ==================== 卡牌容器：自由 3D 軸（拖曳環轉，非單純懸停傾斜） ==================== */
  .card{
    position:relative;
    width:var(--card-w);
    aspect-ratio:100 / 140;
    transform-style: preserve-3d;
    transform: rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));
    will-change: transform;
    cursor: grab;
    touch-action:none;
  }
  .card.dragging{ cursor: grabbing; }
  .card.snapping{ transition: transform .5s cubic-bezier(.2,.8,.2,1); }

  .card__front, .card__back{
    position:absolute; inset:0;
    border-radius:20px;
    backface-visibility:hidden;
    -webkit-backface-visibility:hidden;
    transform-style:preserve-3d;
  }
  .card__back{ transform: rotateY(180deg) translateZ(.5px); }

  /* spinning 時剝除濾鏡/動畫，避免高速旋轉時合成器卡頓或視覺瑕疵 */
  .card.dragging .card__frame,
  .card.dragging .holo,
  .card.dragging .subject,
  .card.dragging .holo__dust{ filter:none !important; animation-play-state:paused !important; }

  /* ---------- 動態金屬外框 ---------- */
  .card__frame{
    position:absolute; inset:0;
    border-radius:inherit;
    padding:var(--frame);
    background:%%FRAME_GRADIENT%%;
    background-size:280% 280%;
    animation: sheen 7s linear infinite;
    filter:
      brightness(var(--sheen,1)) saturate(1.06)
      drop-shadow(0 34px 48px rgba(0,0,0,.62))
      drop-shadow(0 9px 18px rgba(0,0,0,.55));
    box-shadow:
      inset 0 0 0 1px rgba(255,255,255,.30),
      inset 0 0 16px rgba(0,0,0,.55),
      0 0 22px %%FRAME_GLOW%%;
  }
  @keyframes sheen{ from{ background-position:0% 50%; } to{ background-position:280% 50%; } }

  .card__inner{
    position:relative; height:100%;
    border-radius:14px; overflow:hidden;
    isolation:isolate;
    background:radial-gradient(120% 78% at 50% -6%, %%INNER_BG1%% 0%, var(--abyss) 52%, %%INNER_BG2%% 100%);
    box-shadow: inset 0 0 0 1px %%INNER_RING%%, inset 0 0 46px rgba(0,0,0,.72);
  }

  /* ==================== 場景窗 ==================== */
  /* 邊緣柔化遮罩：讓照片內容（尤其色彩對比強的主體區塊）自然融進 card__inner 的環境色，
     不會在金屬外框內側看起來像「另外貼了一張矩形照片」 */
  .scene{
    position:absolute; left:0; right:0; top:0; height:60%; overflow:hidden; z-index:1;
    -webkit-mask-image: radial-gradient(115% 95% at 50% 32%, #000 62%, transparent 100%);
    mask-image: radial-gradient(115% 95% at 50% 32%, #000 62%, transparent 100%);
  }
  .scene img{
    position:absolute; inset:0; width:100%; height:100%;
    object-fit:cover;
    transition: transform .16s ease-out;
    will-change: transform;
    backface-visibility:hidden;
    object-position:%%OBJ_POS%%;
  }
  .scene__bg{ z-index:1; filter: blur(%%BG_BLUR%%px) brightness(%%BG_BRIGHT%%) saturate(%%BG_SAT%%) contrast(1.06); transform: scale(%%BG_SCALE%%); }
  .ghost--warn{
    z-index:2; opacity:%%WARN_OP%%; mix-blend-mode:screen;
    filter:%%WARN_FILTER%%;
    transform: translate(%%WARN_TX%%, %%WARN_TY%%) scale(%%WARN_SCALE%%);
  }
  .ghost--past{
    z-index:3; opacity:%%PAST_OP%%; mix-blend-mode:screen;
    filter:%%PAST_FILTER%%;
    transform: translate(%%PAST_TX%%, %%PAST_TY%%) scale(%%PAST_SCALE%%);
  }
  .scene__veil{ position:absolute; inset:0; z-index:4; pointer-events:none; background:%%VEIL_BG%%; }
  .scene__mist{
    position:absolute; inset:0; z-index:5; pointer-events:none;
    box-shadow: inset 0 -46px 40px var(--abyss), inset 0 24px 26px rgba(0,0,0,.42), inset 0 0 0 1px rgba(0,0,0,.3);
    background:linear-gradient(180deg, var(--abyss) 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 52%, %%MIST_BOT%% 82%, var(--abyss) 100%);
  }

  /* ==================== 全息膜 ==================== */
  .holo{
    position:absolute; inset:0; z-index:6; pointer-events:none;
    mix-blend-mode: color-dodge;
    opacity:.3;
    -webkit-mask-image: linear-gradient(180deg, #000 0 52%, rgba(0,0,0,.22) 64%, rgba(0,0,0,.14) 100%);
    mask-image: linear-gradient(180deg, #000 0 52%, rgba(0,0,0,.22) 64%, rgba(0,0,0,.14) 100%);
  }
  .holo__spectrum{
    position:absolute; inset:0;
    background:
      radial-gradient(38% 30% at var(--gx,50%) var(--gy,50%), rgba(255,255,255,.14), rgba(255,255,255,0) 70%),
      linear-gradient(var(--holo-ang,%%HOLO_ANG0%%deg), %%HOLO_STOPS%%);
    background-size:200% 200%, 320% 320%;
    background-position:0 0, var(--sweep,50%) 50%;
    filter:saturate(1.35) contrast(1.04);
  }
  %%HOLO_FX_CSS%%

  /* ==================== 頂部標記：不透明漸層，永遠可讀，不用 backdrop-filter ==================== */
  .topbar{
    position:absolute; top:15px; left:15px; right:15px; z-index:21;
    transform: translateZ(66px);
    display:flex; justify-content:space-between; align-items:flex-start;
    pointer-events:none;
  }
  .chip{
    font-family:'Cinzel','Noto Sans TC',serif; font-weight:700;
    font-size:11px; letter-spacing:.16em; padding:5px 10px 4px;
    border-radius:8px; border:1px solid rgba(255,255,255,.28);
    text-shadow:0 1px 2px #000;
  }
  .chip--elem{
    color:%%CHIP_ELEM_TEXT%%;
    background:%%CHIP_ELEM_BG%%;
    box-shadow:0 0 14px %%CHIP_ELEM_GLOW%%, inset 0 1px 0 rgba(255,255,255,.4);
  }
  .chip--ssr{
    color:#2a1a00; letter-spacing:.26em;
    background:linear-gradient(120deg,#ffe9a8,#d4af37 55%,#a97d1e);
    border-color:rgba(255,246,214,.65);
    box-shadow:0 0 16px rgba(212,175,55,.55), inset 0 1px 0 rgba(255,255,255,.6);
  }

  /* ==================== 技能面板 ==================== */
  .panel{
    position:absolute; left:0; right:0; bottom:0;
    height:46%; z-index:2;
    padding:14px 17px 16px;
    display:flex; flex-direction:column; gap:8px;
    background:%%PANEL_BG%%;
    border-top:1px solid %%PANEL_TOP_BORDER%%;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 -18px 40px rgba(0,0,0,.42);
  }
  .eyebrow{
    font-family:'Cinzel',serif; font-weight:700; letter-spacing:.32em;
    font-size:10.5px; color:%%EYEBROW_COLOR%%;
    text-shadow:0 0 12px %%EYEBROW_GLOW%%, 0 1px 2px #000;
  }
  .name{
    font-family:'Cinzel','Noto Sans TC',serif; font-weight:900;
    font-size:30px; line-height:1; color:#fbfbf9; letter-spacing:.05em;
    text-shadow:0 0 18px %%NAME_GLOW%%, 0 2px 5px #000;
  }
  .name::after{
    content:""; display:block; margin-top:7px; height:1px; width:100%;
    background:linear-gradient(90deg, %%RULE1%%, %%RULE2%% 45%, transparent);
  }
  .skill{ position:relative; padding-left:12px; margin-top:1px; }
  .skill::before{
    content:""; position:absolute; left:0; top:1px; bottom:3px;
    width:3px; border-radius:2px;
    background:linear-gradient(180deg, var(--c1), rgba(255,255,255,.05));
    box-shadow:0 0 10px var(--c1);
  }
  .skill__name{
    font-family:'Cinzel','Noto Sans TC',serif; font-weight:700; font-size:15px;
    color:%%SKILL_NAME_COLOR%%; text-shadow:0 0 12px %%SKILL_NAME_GLOW%%, 0 1px 2px #000;
  }
  .skill__name span{
    font-family:'Noto Sans TC',sans-serif; font-weight:500; font-size:10.5px;
    color:%%SKILL_SUB_COLOR%%; letter-spacing:.1em; margin-left:4px;
  }
  .skill__desc{
    margin-top:4px; font-size:11.5px; line-height:1.6; color:#e9f1ee;
    text-shadow:0 1px 3px #000, 0 0 7px rgba(0,0,0,.7);
  }
  .skill__desc b{ color:#fff; font-weight:700; text-shadow:0 0 8px %%SKILL_B_GLOW%%, 0 1px 2px #000; }

  /* ==================== 主體：剪裁在卡面內，真實小幅 translateZ 景深 ==================== */
  .subject{
    position:absolute;
    left:50%; bottom:%%SUBJ_BOTTOM%%;
    width:%%SUBJ_WIDTH%%;
    z-index:20;
    pointer-events:none;
    transform:
      translate(-50%, 0)
      translate3d(var(--sx,0px), var(--sy,0px), %%SUBJ_Z%%px)
      rotateX(var(--srx,0deg)) rotateY(var(--sry,0deg))
      scale(var(--sscale,1));
    transition: transform .1s ease-out;
    filter:
      drop-shadow(0 26px 20px rgba(0,0,0,.6))
      drop-shadow(0 10px 10px rgba(0,0,0,.45))
      drop-shadow(0 0 18px %%SUBJ_GLOW%%)
      contrast(1.08) saturate(1.1) brightness(1.02);
  }
  .subject img{ display:block; width:100%; height:auto; }

  /* ==================== 卡背（顏色全部由 --c1/--c2/--c3 推導，不需要額外 token） ==================== */
  .back__frame{
    position:absolute; inset:0; border-radius:20px; padding:var(--frame);
    background:linear-gradient(115deg, #241a05 0%, #8a6a1c 9%, #d8b352 19%, #fff6d8 27%, #b98d2e 35%, #5c4610 47%, #9a7a24 58%, #f4e2a0 70%, #7c5f18 84%, #241a05 100%); background-size:280% 280%; animation: sheen 7s linear infinite;
    filter: brightness(var(--sheen,1)) saturate(1.06) drop-shadow(0 34px 48px rgba(0,0,0,.62)) drop-shadow(0 9px 18px rgba(0,0,0,.55));
    box-shadow: inset 0 0 0 1px rgba(255,244,210,.42), inset 0 0 16px rgba(0,0,0,.55), 0 0 22px rgba(212,175,55,.14);
  }
  .back__inner{
    position:relative; height:100%; border-radius:14px; overflow:hidden;
    background:radial-gradient(120% 100% at 50% 30%, color-mix(in srgb, var(--c1) 22%, var(--abyss)) 0%, var(--abyss) 62%, #030508 100%);
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c2) 26%, transparent), inset 0 0 46px rgba(0,0,0,.8);
  }
  .back__lattice{
    position:absolute; inset:0; opacity:.5;
    background-image:
      repeating-linear-gradient(45deg, color-mix(in srgb, var(--c2) 35%, transparent) 0 1.5px, transparent 1.5px 26px),
      repeating-linear-gradient(-45deg, color-mix(in srgb, var(--c2) 35%, transparent) 0 1.5px, transparent 1.5px 26px);
  }
  .back__emblem{
    position:relative; width:74%; aspect-ratio:1; border-radius:50%;
    background:radial-gradient(closest-side, color-mix(in srgb, var(--c1) 30%, #05070b), #04060a);
    border:2px solid color-mix(in srgb, var(--c2) 60%, transparent);
    box-shadow:0 0 30px color-mix(in srgb, var(--c1) 40%, transparent), inset 0 0 24px rgba(0,0,0,.5);
    display:grid; place-items:center;
  }
  .back__glyph{
    font-family:'Cinzel','Noto Sans TC',serif; font-weight:900; font-size:calc(var(--card-w) * 0.36);
    color:var(--c3); text-shadow:0 0 22px var(--c1), 0 0 6px var(--c2); line-height:1;
  }
  .back__setname{
    position:absolute; bottom:9%; left:0; right:0; text-align:center;
    font-family:'Cinzel',serif; font-weight:700; font-size:10px; letter-spacing:.3em;
    color:var(--c3); text-shadow:0 0 10px var(--c2), 0 1px 2px #000;
  }
  .back__mark{
    position:absolute; top:4%; left:0; right:0; text-align:center;
    font-family:'Cinzel',serif; font-weight:700; font-size:9.5px; letter-spacing:.34em;
    color:rgba(255,255,255,.55);
  }
  .back__medallion{ position:relative; width:60%; aspect-ratio:1; display:grid; place-items:center; }
  .back__ring{
    position:absolute; inset:-7%; border-radius:50%;
    background:
      repeating-conic-gradient(from 0deg, var(--c2) 0deg 3deg, transparent 3deg 15deg),
      radial-gradient(closest-side, transparent 78%, rgba(255,255,255,.06) 79% 100%);
    -webkit-mask: radial-gradient(closest-side, transparent 0 82%, #000 85% 92%, transparent 95%);
    mask: radial-gradient(closest-side, transparent 0 82%, #000 85% 92%, transparent 95%);
    opacity:.7; filter: drop-shadow(0 0 8px var(--c2));
    animation: ringspin 46s linear infinite;
  }
  .back__ring::after{ content:""; position:absolute; inset:9%; border-radius:50%; border:1px solid rgba(255,255,255,.18); }
  @keyframes ringspin{ to{ transform:rotate(360deg); } }
  .back__skill{
    position:relative; margin-top:4px;
    font-family:'Cinzel',serif; font-weight:700; font-size:9px; letter-spacing:.2em;
    color:var(--c3); text-transform:uppercase; text-align:center;
    text-shadow:0 0 10px var(--c2), 0 1px 2px #000; opacity:.85;
  }
  .back__meta{ position:relative; display:flex; align-items:center; gap:8px; margin-top:8px; }
  .back__meta .chip{ font-size:9.5px; padding:4px 8px 3px; }
  .back__id{
    position:relative; margin-top:6px; text-align:center;
    font-family:'Cinzel','Noto Sans TC',serif; font-weight:600; font-size:9px;
    letter-spacing:.16em; color:rgba(255,255,255,.5); text-shadow:0 1px 2px #000;
  }
  .back__corner{ position:absolute; width:20px; height:20px; pointer-events:none; border:2px solid var(--c2); opacity:.5; }
  .back__corner--tl{ top:6%; left:5%; border-right:none; border-bottom:none; border-radius:5px 0 0 0; }
  .back__corner--tr{ top:6%; right:5%; border-left:none; border-bottom:none; border-radius:0 5px 0 0; }
  .back__corner--bl{ bottom:6%; left:5%; border-right:none; border-top:none; border-radius:0 0 0 5px; }
  .back__corner--br{ bottom:6%; right:5%; border-left:none; border-top:none; border-radius:0 0 5px 0; }
  .back__sheen{
    position:absolute; inset:0; pointer-events:none; mix-blend-mode:overlay; opacity:.55;
    background:linear-gradient(115deg, transparent 30%, rgba(255,255,255,.6) 47%, transparent 64%);
    background-size:280% 280%; animation: sheen 7s linear infinite;
  }

  .hint{ font-size:11px; letter-spacing:.14em; color:rgba(230,240,236,.5); text-shadow:0 1px 3px #000; text-align:center; }

  @media (prefers-reduced-motion: reduce){
    .card__frame, .holo__dust, body::before{ animation:none !important; }
    .card, .subject{ transition:none; }
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="card" id="card">
      <div class="card__front">
        <div class="card__frame">
          <div class="card__inner">

            <div class="scene" id="scene">
              <img class="scene__bg"   src="data:image/jpeg;base64,%%IMG_SCENE_B64%%" alt="" />
              <img class="ghost--warn" src="data:image/jpeg;base64,%%IMG_SCENE_B64%%" alt="" />
              <img class="ghost--past" src="data:image/jpeg;base64,%%IMG_SCENE_B64%%" alt="" />
              <div class="scene__veil"></div>
              <div class="scene__mist"></div>
            </div>

            <div class="holo" id="holo">
              <div class="holo__spectrum"></div>
              %%HOLO_FX_HTML%%
            </div>

            <div class="subject" id="subject">
              <img src="data:image/png;base64,%%IMG_SUBJECT_B64%%" alt="" />
            </div>

            <div class="panel">
              <div>
                <p class="eyebrow">%%EYEBROW%%</p>
                <h1 class="name">%%NAME%%</h1>
              </div>
              <div class="skill">
                <p class="skill__name">%%SKILL_NAME%% <span>%%SKILL_EN%%</span></p>
                <p class="skill__desc">%%SKILL_DESC%%</p>
              </div>
            </div>

          </div>
        </div>
        <div class="topbar">
          <span class="chip chip--elem">%%CHIP_ELEM_LABEL%%</span>
          <span class="chip chip--ssr">%%RARITY%%</span>
        </div>
      </div>

      <div class="card__back">
        <div class="back__frame">
          <div class="back__inner">
            <div class="back__lattice"></div>
            <div class="back__sheen"></div>
            <span class="back__corner back__corner--tl"></span>
            <span class="back__corner back__corner--tr"></span>
            <span class="back__corner back__corner--bl"></span>
            <span class="back__corner back__corner--br"></span>
            <p class="back__mark">PHANTOM RESIDUAL · 幻影殘卡</p>
            <div class="back__medallion">
              <div class="back__ring"></div>
              <div class="back__emblem"><span class="back__glyph">%%GLYPH%%</span></div>
            </div>
            <p class="back__skill">%%SKILL_EN%%</p>
            <div class="back__meta">
              <span class="chip chip--elem">%%CHIP_ELEM_LABEL%%</span>
              <span class="chip chip--ssr">%%RARITY%%</span>
            </div>
            <p class="back__id">%%NAME%%</p>
            <p class="back__setname">%%SET_NAME%%</p>
          </div>
        </div>
      </div>
    </div>
    <p class="hint">拖曳卡片自由旋轉 · 雙擊翻面看背面 · 按 L 鍵切換每秒自動翻面循環</p>
  </div>

<script>
(function(){
  "use strict";
  var card    = document.getElementById('card');
  var subject = document.getElementById('subject');
  var pastG   = document.querySelector('.ghost--past');
  var warnG   = document.querySelector('.ghost--warn');
  var bg      = document.querySelector('.scene__bg');
  var holo    = document.getElementById('holo');
  var spectrum= holo.querySelector('.holo__spectrum');

  var HOVER_MAX = 40;     // 懸停傾斜（未拖曳時）
  var PITCH_MAX = 42;     // 拖曳時俯仰角上限（--ry 偏航角不設上限，可自由 360 環轉）
  var DRAG_SENS = 0.5;
  var FRICTION  = 0.94;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var orbit = { rx:0, ry:0 };     // 拖曳/慣性/翻面累積的持久旋轉
  var hover = { ox:0, oy:0 };     // 懸停時的暫態視差（放手即回零）
  var vel   = { rx:0, ry:0 };
  var dragging = false, settling = false;
  var last = { x:0, y:0, t:0 };
  var start = performance.now();

  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function wrap180(d){ d = d % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

  function onPointerDown(e){
    stopAutoFlip();
    dragging = true; settling = false;
    card.classList.add('dragging'); card.classList.remove('snapping');
    last.x = e.clientX; last.y = e.clientY; last.t = performance.now();
    vel.rx = 0; vel.ry = 0;
    try{ card.setPointerCapture(e.pointerId); }catch(_){}
  }
  function onPointerMove(e){
    var r = card.getBoundingClientRect();
    var nx = (e.clientX - r.left) / r.width;
    var ny = (e.clientY - r.top ) / r.height;
    var ox = clamp(nx*2-1, -1, 1), oy = clamp(ny*2-1, -1, 1);

    if (dragging){
      var dx = e.clientX - last.x, dy = e.clientY - last.y;
      var dt = Math.max(1, performance.now() - last.t);
      var dRy = dx * DRAG_SENS, dRx = clamp(-dy * DRAG_SENS, -8, 8);
      orbit.ry += dRy;
      orbit.rx = clamp(orbit.rx + dRx, -PITCH_MAX, PITCH_MAX);
      vel.ry = dRy / dt * 16;
      vel.rx = dRx / dt * 16;
      last.x = e.clientX; last.y = e.clientY; last.t = performance.now();
    } else {
      hover.ox = ox; hover.oy = oy;
    }
    updateParallaxTargets(ox, oy);
  }
  function onPointerUp(){
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    settling = true;
    requestAnimationFrame(inertiaStep);
    startAutoFlip();
  }
  function onPointerLeave(){
    hover.ox = 0; hover.oy = 0;
  }

  function inertiaStep(){
    orbit.ry += vel.ry;
    orbit.rx = clamp(orbit.rx + vel.rx, -PITCH_MAX, PITCH_MAX);
    vel.ry *= FRICTION; vel.rx *= FRICTION;
    if (Math.abs(vel.ry) > 0.02 || Math.abs(vel.rx) > 0.02){
      requestAnimationFrame(inertiaStep);
    } else {
      snapToFace();
    }
  }
  function snapToFace(){
    settling = false;
    card.classList.add('snapping');
    orbit.ry = Math.round(orbit.ry/180)*180;
    orbit.rx = 0;
    setTimeout(function(){ card.classList.remove('snapping'); }, 520);
  }
  function flip(){
    card.classList.add('snapping');
    orbit.ry = Math.round(orbit.ry/180)*180 + 180;
    orbit.rx = 0;
    setTimeout(function(){ card.classList.remove('snapping'); }, 520);
  }

  var AUTO_FLIP_MS = 1000;
  var autoFlipOn = false;    // 使用者是否已用快捷鍵開啟此模式（預設關閉，卡片維持靜止）
  var autoFlipTimer = null;  // 實際跑的計時器（拖曳中會暫停，但不影響 autoFlipOn）
  function startAutoFlip(){
    if (autoFlipTimer || !autoFlipOn) return; // 不看 reduce：這是使用者按快捷鍵主動開啟的模式
    autoFlipTimer = setInterval(function(){
      if (!dragging && !settling) flip();
    }, AUTO_FLIP_MS);
  }
  function stopAutoFlip(){
    if (!autoFlipTimer) return;
    clearInterval(autoFlipTimer);
    autoFlipTimer = null;
  }
  function toggleAutoFlip(){
    autoFlipOn = !autoFlipOn;
    if (autoFlipOn) startAutoFlip(); else stopAutoFlip();
  }
  // 讓桌面掛件外殼（main.js 的 INJECTED_SCRIPT，跟這段卡片腳本同一個
  // window/主世界）能從外部呼叫，藉此把 AUTOFLIP_KEY 全域快捷鍵轉發進來——
  // 卡片單獨用瀏覽器打開時完全不受影響，這個屬性平常沒人讀也沒差。
  window.toggleAutoFlip = toggleAutoFlip;
  window.addEventListener('keydown', function(e){
    if (e.key === 'l' || e.key === 'L') toggleAutoFlip();
  });

  card.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive:true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  card.addEventListener('pointerleave', onPointerLeave);
  card.addEventListener('dblclick', flip);
  window.addEventListener('blur', onPointerUp);
  document.addEventListener('visibilitychange', function(){ if (document.hidden) onPointerUp(); });

  window.addEventListener('deviceorientation', function(e){
    if (dragging || e.gamma==null || e.beta==null) return;
    hover.ox = clamp(e.gamma/28, -1, 1);
    hover.oy = clamp((e.beta-42)/28, -1, 1);
    updateParallaxTargets(0.5+hover.ox/2, 0.5+hover.oy/2);
  }, true);

  var px = { gx:50, gy:50, mag:0 };
  function updateParallaxTargets(nx, ny){
    px.gx = clamp(nx*100,0,100); px.gy = clamp(ny*100,0,100);
    px.mag = Math.min(1, Math.hypot(nx*2-1, ny*2-1));
  }

  function frame(t){
    if (!dragging && !settling && !reduce){
      var s = (t-start)/1000;
      if (Math.hypot(hover.ox,hover.oy) < 0.02){
        hover.ox = Math.sin(s*0.7)*0.28; hover.oy = Math.cos(s*0.52)*0.2;
      }
    }
    var faceRy = wrap180(orbit.ry);
    var fx = clamp(faceRy/90, -1, 1);
    var fy = clamp(orbit.rx/PITCH_MAX, -1, 1);
    var hx = dragging ? 0 : hover.ox;
    var hy = dragging ? 0 : hover.oy;

    var finalRx = orbit.rx + hy*HOVER_MAX*0.35;
    var finalRy = orbit.ry + hx*HOVER_MAX*0.55;

    card.style.setProperty('--rx', finalRx.toFixed(2)+'deg');
    card.style.setProperty('--ry', finalRy.toFixed(2)+'deg');

    var mag = Math.min(1, Math.hypot(fx,fy) + Math.hypot(hx,hy)*0.4);
    card.style.setProperty('--sheen', (1 + mag*0.55).toFixed(3));

    var ox = clamp(fx + hx*0.5, -1, 1), oy = clamp(fy + hy*0.5, -1, 1);
    var bx = -ox, by = -oy;

    subject.style.setProperty('--sx', (ox * 8).toFixed(1)+'px');
    subject.style.setProperty('--sy', (oy * 6 - mag*2).toFixed(1)+'px');
    subject.style.setProperty('--srx', (-by*4).toFixed(2)+'deg');
    subject.style.setProperty('--sry', (bx*4).toFixed(2)+'deg');
    subject.style.setProperty('--sscale', (1 + mag*0.02).toFixed(3));

    bg.style.transform    = 'scale(%%BG_SCALE%%) translate(' + (bx*7).toFixed(1) + 'px,' + (by*6).toFixed(1) + 'px)';
    warnG.style.transform = 'translate(calc(%%WARN_TX%% + '  + (bx*34).toFixed(1) + 'px), calc(%%WARN_TY%% + ' + (by*30).toFixed(1) + 'px)) scale(%%WARN_SCALE%%)';
    pastG.style.transform = 'translate(calc(%%PAST_TX%% + '  + (bx*58).toFixed(1) + 'px), calc(%%PAST_TY%% + ' + (by*52).toFixed(1) + 'px)) scale(%%PAST_SCALE%%)';

    var ang = Math.atan2(oy, ox)*180/Math.PI + %%HOLO_ANG0%%;
    spectrum.style.setProperty('--holo-ang', ang.toFixed(1)+'deg');
    spectrum.style.setProperty('--gx', (50+ox*50).toFixed(1)+'%');
    spectrum.style.setProperty('--gy', (50+oy*50).toFixed(1)+'%');
    spectrum.style.setProperty('--sweep', (50 + ox*55).toFixed(1)+'%');
    holo.style.opacity = (0.14 + mag*0.30).toFixed(3);
    holo.style.setProperty('--dx', (ox*-16).toFixed(1)+'px');
    holo.style.setProperty('--dy', (oy*-16).toFixed(1)+'px');
    holo.style.setProperty('--fx', ox.toFixed(3));
    holo.style.setProperty('--fy', oy.toFixed(3));

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'){
    var ask = function(){ DeviceOrientationEvent.requestPermission().catch(function(){}); window.removeEventListener('click', ask); };
    window.addEventListener('click', ask);
  }
})();
</script>
</body>
</html>
"""
