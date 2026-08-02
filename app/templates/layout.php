<?php

declare(strict_types=1);

use function Agentic\Dashboard\e;

/** @var string $title */
/** @var string $content */
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= e($title) ?> · agentic-attribution</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; --accent:#0369a1; --good:#15803d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif; }
  header { background:#fff; border-bottom:1px solid var(--line); padding:16px 24px; }
  header a { color:var(--ink); text-decoration:none; font-weight:600; }
  main { max-width:1000px; margin:0 auto; padding:24px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:16px; margin:28px 0 10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .sub { color:var(--muted); margin:0 0 20px; }
  table { border-collapse:collapse; width:100%; background:#fff; border:1px solid var(--line); }
  th,td { padding:10px 12px; text-align:left; border-bottom:1px solid var(--line); }
  th { background:#f1f5f9; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  a { color:var(--accent); }
  code { font-family:"Cascadia Mono",Consolas,monospace; font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; }
  .card { background:#fff; border:1px solid var(--line); padding:14px 16px; }
  .card .k { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .card .v { font-size:22px; font-variant-numeric:tabular-nums; margin-top:4px; }
  .chain { list-style:none; margin:0; padding:0; }
  .chain li { background:#fff; border:1px solid var(--line); border-left:3px solid var(--accent); padding:12px 16px; margin-bottom:8px; }
  .chain .step { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; background:#dcfce7; color:var(--good); }
  .pill.other { background:#fee2e2; color:#b91c1c; }
  .err { background:#fff; border:1px solid var(--line); border-left:3px solid #b91c1c; padding:16px; }
  .controls { background:#fff; border:1px solid var(--line); padding:14px 16px; margin-bottom:18px;
              display:flex; flex-wrap:wrap; gap:14px; align-items:center; }
  .controls button { font:inherit; padding:7px 16px; border:1px solid var(--line); background:#fff;
                     cursor:pointer; border-radius:3px; }
  .controls button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .controls button[disabled] { opacity:.45; cursor:default; }
  .controls label { font-size:13px; color:var(--muted); display:flex; gap:7px; align-items:center; }
  .controls input[type=number] { font:inherit; width:64px; padding:5px 7px; border:1px solid var(--line); }
  .live { font-size:13px; color:var(--muted); margin-left:auto; font-variant-numeric:tabular-nums;
          display:flex; gap:6px; align-items:center; }
  .live b { color:var(--fg); font-weight:600; }
  .chip { font:inherit; font-size:13px; color:var(--muted); background:transparent;
          border:1px solid var(--line); border-radius:12px; padding:3px 10px; cursor:pointer; }
  .chip:hover { border-color:var(--accent); color:var(--fg); }
  .chip.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .chip.on b { color:#fff; }
  th.sortable { cursor:pointer; user-select:none; white-space:nowrap; }
  th.sortable:hover { color:var(--accent); }
  th.sortable::after { content:"\2195"; opacity:.28; margin-left:5px; font-size:11px; }
  th.sortable.asc::after { content:"\2191"; opacity:1; }
  th.sortable.desc::after { content:"\2193"; opacity:1; }
  .blocked { color:#b91c1c; font-variant-numeric:tabular-nums; }
  .event { font-size:12px; color:var(--muted); margin-top:10px; min-height:1.2em;
           font-family:"Cascadia Mono",Consolas,monospace; }
  /* Rows the poll just changed flash once, so a viewer sees which publisher
     transacted rather than hunting for the number that moved. */
  @keyframes settled { from { background:#dcfce7; } to { background:transparent; } }
  tr.changed td { animation:settled 1.1s ease-out; }
</style>
</head>
<body>
<header data-testid="site-header"><a data-testid="home-link" href="/">agentic-attribution</a> <span style="color:var(--muted);font-weight:400">publisher dashboard</span></header>
<main data-testid="page-content"><?= $content ?></main>
</body>
</html>
