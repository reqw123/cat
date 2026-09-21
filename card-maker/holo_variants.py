HOLO_VARIANTS = {
    "dust": {
        "css": """
  .holo__dust{
    position:absolute; inset:-25%;
    background-image:
      radial-gradient(rgba(255,255,255,.95) .6px, transparent 1.4px),
      radial-gradient(%%DUSTC2%% .7px, transparent 1.6px),
      radial-gradient(%%DUSTC3%% .6px, transparent 1.4px);
    background-size:17px 17px, 26px 26px, 39px 41px;
    background-position:0 0, 8px 11px, 19px 4px;
    transform: translate(var(--dx,0px), var(--dy,0px));
    animation: dustDrift 12s linear infinite;
    opacity:.5;
  }
  @keyframes dustDrift{
    from{ background-position:0 0, 8px 11px, 19px 4px; }
    to  { background-position:34px -46px, -30px 37px, 52px 44px; }
  }""",
        "html": '<div class="holo__dust"></div>',
    },
    "chrome_scan": {
        "css": """
  .holo__scan{
    position:absolute; inset:0;
    background-image:
      repeating-linear-gradient(100deg, rgba(255,255,255,.14) 0 2px, transparent 2px 15px),
      linear-gradient(100deg, transparent 32%, rgba(255,255,255,.4) 49%, transparent 64%);
    background-size:100% 100%, 240% 100%;
    background-position:0 0, 0% 0;
    mix-blend-mode: overlay;
    animation: scanSweep 3.2s ease-in-out infinite;
  }
  @keyframes scanSweep{ 0%,100%{ background-position:0 0, -60% 0;} 50%{ background-position:0 0, 160% 0;} }""",
        "html": '<div class="holo__scan"></div>',
    },
    "embers": {
        "css": """
  .holo__embers{ position:absolute; inset:-6% -10% -46% -10%; mix-blend-mode:screen; opacity:.9; }
  .holo__embers i{
    position:absolute; inset:0; display:block;
    background-image:
      radial-gradient(2.6px 2.6px at 12% 95%, %%EMBERC1%%, transparent 60%),
      radial-gradient(2px 2px at 32% 92%, %%EMBERC2%%, transparent 60%),
      radial-gradient(2.4px 2.4px at 54% 96%, %%EMBERC1%%, transparent 60%),
      radial-gradient(2px 2px at 74% 90%, %%EMBERC2%%, transparent 60%),
      radial-gradient(2.8px 2.8px at 90% 95%, %%EMBERC1%%, transparent 60%);
    animation: emberRise 4.6s linear infinite;
  }
  .holo__embers i:nth-child(2){ animation-delay:1.5s; }
  .holo__embers i:nth-child(3){ animation-delay:3s; }
  @keyframes emberRise{
    0%{ transform:translateY(0) scale(1); opacity:0; }
    12%{ opacity:.9; }
    100%{ transform:translateY(-78%) scale(1.2); opacity:0; }
  }""",
        "html": '<div class="holo__embers"><i></i><i></i><i></i></div>',
    },
    "grid_bokeh": {
        "css": """
  .holo__grid{
    position:absolute; inset:0;
    background-image:
      linear-gradient(rgba(255,255,255,.16) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.16) 1px, transparent 1px),
      radial-gradient(18% 14% at 22% 28%, rgba(255,255,255,.55), transparent 70%),
      radial-gradient(14% 11% at 76% 66%, rgba(255,255,255,.4), transparent 70%);
    background-size:24px 24px, 24px 24px, 100% 100%, 100% 100%;
    mix-blend-mode:overlay;
    animation: gridDrift 8s linear infinite;
    opacity:.62;
  }
  @keyframes gridDrift{ from{ background-position:0 0,0 0,0 0,0 0; } to{ background-position:24px 24px,24px 24px,0 0,0 0; } }""",
        "html": '<div class="holo__grid"></div>',
    },
    "radar": {
        "css": """
  .holo__radar{
    position:absolute; left:50%; top:38%; width:130%; aspect-ratio:1;
    transform:translate(-50%,-50%);
    border-radius:50%;
    background: conic-gradient(from 0deg, transparent 0deg, rgba(255,255,255,.55) 16deg, transparent 38deg);
    mix-blend-mode:screen;
    animation: radarSpin 3.4s linear infinite;
    opacity:.5;
  }
  @keyframes radarSpin{ to{ transform: translate(-50%,-50%) rotate(360deg); } }""",
        "html": '<div class="holo__radar"></div>',
    },
    "speedlines": {
        "css": """
  .holo__speed{
    position:absolute; inset:0;
    background-image: repeating-linear-gradient(100deg, rgba(255,255,255,.55) 0 3px, transparent 3px 28px);
    mix-blend-mode:screen;
    animation: speedShift 0.9s linear infinite;
    opacity:.38;
    -webkit-mask-image: linear-gradient(100deg, transparent 0%, #000 32%, #000 68%, transparent 100%);
    mask-image: linear-gradient(100deg, transparent 0%, #000 32%, #000 68%, transparent 100%);
  }
  @keyframes speedShift{ from{ background-position:0 0; } to{ background-position:-140px 0; } }""",
        "html": '<div class="holo__speed"></div>',
    },
}
