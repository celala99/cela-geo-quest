import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 世良地理クエスト（プレイ専用版）
 * - public/data.json を fetch して全員共通データで動く
 * - 画像は public/monsters/*.png を参照（base64等で保存しない）
 * - 進捗（図鑑登録）とプレイヤー名だけ localStorage（軽量）
 * - iPhone/Safariを想定し、Audio はユーザー操作後に再生開始
 */

/** ===== Types ===== */
type PrefName = string;

type Quiz = {
  q: string;
  c: [string, string, string, string];
  a: number; // 0..3
  hint?: string;
};

type Monster = {
  name: string;
  species: string; // 属性など
  image: string; // "/monsters/hokkaido.png" など
  desc: string; // 図鑑説明文（ポケモン図鑑っぽい）
  difficulty: number; // 1..5
  hp: number; // 例: 7
  quizzes: Quiz[];
};

type DataJson = {
  version: number;
  monsters: Record<PrefName, Monster>;
};

/** ===== Storage (small only) ===== */
const LS_PLAYER = "sgq_player_name_v1";
const LS_DEX = "sgq_dex_v1"; // { [pref]: true }

function safeParse<T>(s: string | null, fallback: T): T {
  try {
    if (!s) return fallback;
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
function loadDex(): Record<string, true> {
  return safeParse<Record<string, true>>(localStorage.getItem(LS_DEX), {});
}
function saveDex(dex: Record<string, true>) {
  localStorage.setItem(LS_DEX, JSON.stringify(dex));
}

/** ===== Helpers ===== */
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}


function calcPlayerMaxHp(): number {
  return 5; // シンプル固定（あとで拡張しやすい）
}

function calcEnemyMaxHp(m: Monster): number {
  // difficulty と hp をベースに微調整（軽く）
  const base = clamp(m.hp ?? 7, 3, 30);
  const diff = clamp(m.difficulty ?? 3, 1, 5);
  return clamp(base + (diff - 3), 3, 30);
}

function calcDamage(attacker: "player" | "enemy", difficulty: number): number {
  // 軽いRPG風：難易度が上がるほど敵が硬い・攻撃が痛い
  const d = clamp(difficulty ?? 3, 1, 5);
  if (attacker === "player") return d <= 2 ? 2 : d === 3 ? 2 : 1; // 難しいほど1になりやすい
  return d <= 2 ? 1 : d === 3 ? 1 : 2; // 難しいほど2になりやすい
}

function isValidData(x: any): x is DataJson {
  return (
    x &&
    typeof x === "object" &&
    typeof x.version === "number" &&
    x.monsters &&
    typeof x.monsters === "object"
  );
}

/** ===== BGM ===== */
type BgmState = "off" | "on";

function useBgm(url: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<BgmState>("off");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!url) return;
    const a = new Audio(url);
    a.loop = true;
    a.preload = "auto";
    a.volume = 0.35;
    audioRef.current = a;

    const onCanPlay = () => setReady(true);
    a.addEventListener("canplay", onCanPlay);

    return () => {
      a.pause();
      a.removeEventListener("canplay", onCanPlay);
      audioRef.current = null;
    };
  }, [url]);

  const start = async () => {
    const a = audioRef.current;
    if (!a) return;
    try {
      await a.play(); // Safariはユーザー操作後のみ通る
      setState("on");
    } catch {
      // ユーザー操作前だと失敗することがあるので無視
      setState("off");
    }
  };

  const stop = () => {
    const a = audioRef.current;
    if (!a) return;
    a.pause();
    a.currentTime = 0;
    setState("off");
  };

  return { state, ready, start, stop };
}

/** ===== UI Components (simple) ===== */
function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const { variant = "ghost", className = "", ...rest } = props;
  const base =
    "px-4 py-3 rounded-2xl text-base font-semibold transition active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed";
  const v =
    variant === "primary"
      ? "bg-gradient-to-r from-sky-500 to-indigo-600 text-white shadow-lg shadow-sky-500/20 hover:brightness-110"
      : variant === "danger"
      ? "bg-gradient-to-r from-rose-500 to-orange-500 text-white shadow-lg shadow-rose-500/20 hover:brightness-110"
      : "bg-white/70 hover:bg-white text-slate-900 shadow-md shadow-black/5";
  return <button className={`${base} ${v} ${className}`} {...rest} />;
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/70 shadow-sm shadow-black/5 text-sm font-semibold text-slate-700">
      {children}
    </div>
  );
}

function HpBar({ label, hp, max }: { label: string; hp: number; max: number }) {
  const pct = max <= 0 ? 0 : Math.round((clamp(hp, 0, max) / max) * 100);
  const color =
    pct > 60 ? "bg-emerald-500" : pct > 30 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
        <span>{label}</span>
        <span className="tabular-nums">
          HP {clamp(hp, 0, max)}/{max}
        </span>
      </div>
      <div className="mt-1 w-full h-3 rounded-full bg-slate-200 overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** ===== Scenes ===== */
type Scene = "loading" | "title" | "name" | "map" | "battle" | "result" | "dex";

type BattleState = {
  pref: PrefName;
  enemy: Monster;
  enemyHp: number;
  enemyMaxHp: number;
  playerHp: number;
  playerMaxHp: number;
  quizIndex: number;
  lastMsg: string | null;
  finished: null | "win" | "lose";
  answered: boolean;
  grayscaleEnemy: boolean;
};

const DEFAULT_TITLE_BG = ""; // 背景JPEGを入れるなら public に置いて "/title.jpg" みたいに指定

export default function App() {
  const [scene, setScene] = useState<Scene>("loading");
  const [data, setData] = useState<DataJson | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [playerName, setPlayerName] = useState<string>(() => localStorage.getItem(LS_PLAYER) || "");
  const [dex, setDex] = useState<Record<string, true>>(() => loadDex());

  // BGM（あとで差し替え）：public/bgm/battle.mp3 を置いたらこのURLに
  const battleBgmUrl = "/bgm/battle.mp3"; // ←ファイル未配置でもOK（再生失敗しても動作はする）
  const bgm = useBgm(battleBgmUrl);

  const prefs = useMemo(() => {
    if (!data) return [] as PrefName[];
    return Object.keys(data.monsters);
  }, [data]);

  const [battle, setBattle] = useState<BattleState | null>(null);

  /** Load data.json */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/data.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`data.json 読み込み失敗 (${res.status})`);
        const json = await res.json();
        if (!isValidData(json)) throw new Error("data.json の形式が不正です");
        setData(json);
        setScene("title");
      } catch (e: any) {
        setErr(String(e?.message || e));
        setScene("loading");
      }
    })();
  }, []);

  /** Persist */
  useEffect(() => {
    localStorage.setItem(LS_PLAYER, playerName);
  }, [playerName]);

  useEffect(() => {
    saveDex(dex);
  }, [dex]);

  /** Dev assertions (light “tests”) */
  useEffect(() => {
    if (import.meta.env.DEV && data) {
      console.assert(Object.keys(data.monsters).length >= 1, "monsters should not be empty");
      const anyPref = Object.keys(data.monsters)[0];
      console.assert(typeof data.monsters[anyPref]?.image === "string", "monster.image should be string");
    }
  }, [data]);

  /** Start battle */
  const startBattle = (pref: PrefName) => {
    if (!data) return;
    const m = data.monsters[pref];
    if (!m) return;

    const playerMaxHp = calcPlayerMaxHp();
    const enemyMaxHp = calcEnemyMaxHp(m);

    const quizzes = m.quizzes ?? [];
    const quizIndex = quizzes.length > 0 ? 0 : -1;

    setBattle({
      pref,
      enemy: m,
      enemyHp: enemyMaxHp,
      enemyMaxHp,
      playerHp: playerMaxHp,
      playerMaxHp,
      quizIndex,
      lastMsg: `${m.name} が あらわれた！`,
      finished: null,
      answered: false,
      grayscaleEnemy: false,
    });
    setScene("battle");
  };

  const goMap = () => {
    bgm.stop();
    setBattle(null);
    setScene("map");
  };

  const goDex = () => {
    bgm.stop();
    setBattle(null);
    setScene("dex");
  };

  /** Answer quiz */
  const answer = (choiceIdx: number) => {
    if (!battle || battle.finished) return;
    const { enemy } = battle;

    const quizzes = enemy.quizzes ?? [];
    if (quizzes.length === 0 || battle.quizIndex < 0) {
      // クイズ未設定の場合：とりあえず通常攻撃にする
      const dmg = 1;
      const newHp = clamp(battle.enemyHp - dmg, 0, battle.enemyMaxHp);
      const win = newHp <= 0;

      setBattle((b) =>
        b
          ? {
              ...b,
              enemyHp: newHp,
              lastMsg: win ? `${enemy.name} を たおした！` : `${enemy.name} に ${dmg} ダメージ！`,
              finished: win ? "win" : null,
              grayscaleEnemy: win ? true : b.grayscaleEnemy,
              answered: true,
            }
          : b
      );
      if (win) {
        setDex((d) => ({ ...d, [battle.pref]: true }));
        setScene("result");
      }
      return;
    }

    const q = quizzes[battle.quizIndex];
    const correct = q.a === choiceIdx;

    // player turn
    if (correct) {
      const dmg = calcDamage("player", enemy.difficulty);
      const newEnemyHp = clamp(battle.enemyHp - dmg, 0, battle.enemyMaxHp);
      const win = newEnemyHp <= 0;

      setBattle((b) =>
        b
          ? {
              ...b,
              enemyHp: newEnemyHp,
              lastMsg: win
                ? `正解！ ${enemy.name} を たおした！`
                : `正解！ ${enemy.name} に ${dmg} ダメージ！`,
              finished: win ? "win" : null,
              grayscaleEnemy: win ? true : b.grayscaleEnemy,
              answered: true,
            }
          : b
      );

      if (win) {
        setDex((d) => ({ ...d, [battle.pref]: true }));
        setTimeout(() => setScene("result"), 450);
        return;
      }

      // enemy counter after small delay
      setTimeout(() => {
        setBattle((b) => {
          if (!b || b.finished) return b;
          const edmg = calcDamage("enemy", enemy.difficulty);
          const newPlayerHp = clamp(b.playerHp - edmg, 0, b.playerMaxHp);
          const lose = newPlayerHp <= 0;

          return {
            ...b,
            playerHp: newPlayerHp,
            lastMsg: lose ? `${enemy.name} のこうげき！ まけてしまった…` : `${enemy.name} のこうげき！ ${edmg} ダメージ…`,
            finished: lose ? "lose" : null,
            answered: false,
            quizIndex: b.quizIndex + 1 < (enemy.quizzes?.length ?? 0) ? b.quizIndex + 1 : 0,
          };
        });

        setTimeout(() => {
          setBattle((b) => (b && b.finished === "lose" ? b : b));
          if (battle.playerHp <= 0) setScene("result");
        }, 50);
      }, 550);
    } else {
      // wrong: enemy hits immediately
      const edmg = calcDamage("enemy", enemy.difficulty);
      const newPlayerHp = clamp(battle.playerHp - edmg, 0, battle.playerMaxHp);
      const lose = newPlayerHp <= 0;

      setBattle((b) =>
        b
          ? {
              ...b,
              playerHp: newPlayerHp,
              lastMsg: lose
                ? `不正解… ${enemy.name} のこうげき！ まけてしまった…`
                : `不正解… ${enemy.name} のこうげき！ ${edmg} ダメージ…`,
              finished: lose ? "lose" : null,
              answered: false,
              quizIndex: b.quizIndex + 1 < (enemy.quizzes?.length ?? 0) ? b.quizIndex + 1 : 0,
            }
          : b
      );

      if (lose) {
        setTimeout(() => setScene("result"), 450);
      }
    }
  };

  /** ===== Render ===== */
  const rootBg =
    "min-h-screen w-full bg-[radial-gradient(ellipse_at_top,_rgba(56,189,248,0.18),transparent_50%),radial-gradient(ellipse_at_bottom,_rgba(99,102,241,0.18),transparent_50%),linear-gradient(135deg,#fff7d6,#eaf6ff)]";

  if (!data && scene === "loading") {
    return (
      <div className={`${rootBg} flex items-center justify-center p-6`}>
        <div className="w-full max-w-md rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 p-6">
          <div className="text-2xl font-extrabold text-slate-900">世良地理クエスト</div>
          <div className="mt-2 text-slate-700">データを読み込み中…</div>
          {err && (
            <div className="mt-4 rounded-2xl bg-rose-50 border border-rose-200 p-4 text-rose-700 text-sm">
              <div className="font-bold">読み込みエラー</div>
              <div className="mt-1 whitespace-pre-wrap">{err}</div>
              <div className="mt-2 text-xs text-rose-600">
                ※ public/data.json がGitHub Pages側に置かれているか確認してね
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Shared header
  const Header = ({ right }: { right?: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <div className="text-xl font-extrabold text-slate-900">世良地理クエスト</div>
        <Pill>プレイ版</Pill>
      </div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  );

  // Title
  if (scene === "title") {
    return (
      <div className={`${rootBg} p-6 flex items-center justify-center`}>
        <div className="w-full max-w-xl rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 overflow-hidden">
          <div
            className="p-8 relative"
            style={{
              backgroundImage: DEFAULT_TITLE_BG ? `url(${DEFAULT_TITLE_BG})` : undefined,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          >
            <Header
              right={
                <Button
                  variant="ghost"
                  onClick={() => {
                    setScene("dex");
                  }}
                >
                  図鑑
                </Button>
              }
            />
            <div className="mt-10">
              <div className="text-4xl font-black tracking-tight text-slate-900">
                地理で戦え。
              </div>
              <div className="mt-3 text-slate-700 text-lg">
                都道府県モンスターを倒して図鑑を埋めよう！
              </div>
              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <Button
                  variant="primary"
                  onClick={() => {
                    // BGMはユーザー操作後でないとSafariで鳴らないので、ここではまだstartしない
                    setScene(playerName.trim() ? "map" : "name");
                  }}
                >
                  スタート
                </Button>
                <Button
                  onClick={() => {
                    setScene("name");
                  }}
                >
                  名前を設定
                </Button>
              </div>
            </div>
          </div>

          <div className="p-6 border-t border-white/40">
            <div className="flex items-center justify-between gap-3">
              <div className="text-slate-700">
                プレイヤー： <span className="font-bold text-slate-900">{playerName.trim() || "未設定"}</span>
              </div>
              <div className="text-slate-700">
                図鑑： <span className="font-bold text-slate-900">{Object.keys(dex).length}</span> /{" "}
                <span className="font-bold text-slate-900">{prefs.length}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Name
  if (scene === "name") {
    return (
      <div className={`${rootBg} p-6 flex items-center justify-center`}>
        <div className="w-full max-w-xl rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 p-6">
          <Header right={<Button onClick={() => setScene("title")}>戻る</Button>} />
          <div className="mt-6 text-slate-700">
            生徒が自分の名前を決めると、バトル画面に表示されます。
          </div>
          <div className="mt-4">
            <label className="text-sm font-bold text-slate-800">プレイヤー名</label>
            <input
              className="mt-2 w-full px-4 py-3 rounded-2xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-400"
              placeholder="例：地理勇者セラ"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={16}
            />
            <div className="mt-2 text-xs text-slate-500">最大16文字</div>
          </div>
          <div className="mt-6 flex gap-3">
            <Button variant="primary" onClick={() => setScene("map")} disabled={!playerName.trim()}>
              決定してマップへ
            </Button>
            <Button
              onClick={() => {
                setPlayerName("");
              }}
            >
              クリア
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Map (simple grid map)
  if (scene === "map") {
    return (
      <div className={`${rootBg} p-6`}>
        <div className="mx-auto max-w-5xl">
          <Header
            right={
              <>
                <Pill>プレイヤー：{playerName.trim() || "未設定"}</Pill>
                <Button onClick={() => setScene("dex")}>図鑑</Button>
                <Button onClick={() => setScene("title")}>タイトル</Button>
              </>
            }
          />
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 p-6">
              <div className="flex items-center justify-between">
                <div className="text-lg font-extrabold text-slate-900">日本マップ（簡易）</div>
                <Pill>
                  図鑑 {Object.keys(dex).length}/{prefs.length}
                </Pill>
              </div>

              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {prefs.map((p) => {
                  const captured = !!dex[p];
                  const m = data!.monsters[p];
                  return (
                    <button
                      key={p}
                      onClick={() => {
                        const ok = window.confirm(`${p}（${m.name}）と戦いますか？`);
                        if (ok) startBattle(p);
                      }}
                      className={`group text-left rounded-2xl p-3 border transition ${
                        captured
                          ? "bg-slate-50 border-slate-200"
                          : "bg-white border-slate-200 hover:border-sky-300 hover:shadow-lg hover:shadow-sky-500/10"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-extrabold text-slate-900 text-sm">{p}</div>
                        {captured ? (
                          <span className="text-xs font-bold text-emerald-600">GET</span>
                        ) : (
                          <span className="text-xs font-bold text-slate-400">未</span>
                        )}
                      </div>
                      <div className="mt-2 text-xs text-slate-600 line-clamp-2">
                        {m.name} / 難易度 {m.difficulty}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 text-xs text-slate-600">
                ※ ここは「簡易マップ」です。本物の都道府県地図クリック版にも後で差し替えできます。
              </div>
            </div>

            <div className="rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 p-6">
              <div className="text-lg font-extrabold text-slate-900">今日のミッション</div>
              <div className="mt-3 text-slate-700">
                まずは「クイズが入っている県」を倒して図鑑登録してみよう。
              </div>
              <div className="mt-4 rounded-2xl bg-sky-50 border border-sky-200 p-4">
                <div className="font-bold text-sky-800">先生向けメモ</div>
                <ul className="mt-2 text-sm text-sky-800/90 list-disc pl-5 space-y-1">
                  <li>クイズは public/data.json の quizzes に追加すると全員に反映</li>
                  <li>画像は public/monsters/*.png を差し替えるだけ</li>
                  <li>生徒の端末にはデータは保存されない（読むだけ）</li>
                </ul>
              </div>

              <div className="mt-5 flex gap-2">
                <Button
                  variant="danger"
                  onClick={() => {
                    const ok = window.confirm("図鑑（GET状態）だけリセットしますか？この端末だけに作用します。");
                    if (ok) setDex({});
                  }}
                >
                  図鑑リセット
                </Button>
              </div>

              <div className="mt-4 text-xs text-slate-500">
                ※ 図鑑のGETは「この端末だけ」です（生徒個別の達成感用）。
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Battle
  if (scene === "battle" && battle) {
    const enemy = battle.enemy;
    const quizzes = enemy.quizzes ?? [];
    const hasQuiz = quizzes.length > 0 && battle.quizIndex >= 0;
    const quiz = hasQuiz ? quizzes[battle.quizIndex] : null;

    return (
      <div className={`${rootBg} p-6`}>
        <div className="mx-auto max-w-4xl">
          <Header
            right={
              <>
                <Pill>{battle.pref}</Pill>
                <Button
                  onClick={() => {
                    const ok = window.confirm("マップへ戻りますか？（戦闘は中断）");
                    if (ok) goMap();
                  }}
                >
                  マップへ
                </Button>
              </>
            }
          />

          <div className="mt-6 rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 overflow-hidden">
            {/* Battle field */}
            <div className="relative p-6 sm:p-8 bg-[linear-gradient(135deg,rgba(255,255,255,0.85),rgba(255,255,255,0.55))]">
              {/* Enemy */}
              <div className="flex items-start justify-between gap-6">
                <div className="max-w-sm w-full rounded-2xl bg-white/70 p-4 shadow-md shadow-black/5">
                  <HpBar label={enemy.name} hp={battle.enemyHp} max={battle.enemyMaxHp} />
                  <div className="mt-2 flex items-center gap-2">
                    <Pill>属性：{enemy.species || "未設定"}</Pill>
                    <Pill>難易度：{enemy.difficulty}</Pill>
                  </div>
                </div>

                <div className="relative">
                  {/* 影っぽい四角が出ないように：背景は透明、枠なし、影はdrop-shadowだけ */}
                  <img
                    src={enemy.image}
                    alt={enemy.name}
                    className={`select-none pointer-events-none max-h-[220px] sm:max-h-[260px] md:max-h-[300px] w-auto object-contain ${
                      battle.grayscaleEnemy ? "grayscale" : ""
                    }`}
                    style={{
                      filter: battle.grayscaleEnemy
                        ? "grayscale(1) drop-shadow(0 18px 30px rgba(0,0,0,0.14))"
                        : "drop-shadow(0 18px 30px rgba(0,0,0,0.14))",
                      background: "transparent",
                    }}
                  />
                </div>
              </div>

              {/* Player */}
              <div className="mt-8 flex items-end justify-between gap-6">
                <div className="flex items-center gap-4">
                  <div className="h-28 w-28 rounded-full bg-slate-900/90 text-white flex items-center justify-center font-extrabold shadow-lg shadow-black/10">
                    <div className="text-center leading-tight">
                      <div className="text-base">{playerName.trim() || "プレイヤー"}</div>
                      <div className="text-xs opacity-80">Teacher</div>
                    </div>
                  </div>
                  <div className="max-w-sm w-full rounded-2xl bg-white/70 p-4 shadow-md shadow-black/5">
                    <HpBar label={playerName.trim() || "プレイヤー"} hp={battle.playerHp} max={battle.playerMaxHp} />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      // BGMはユーザー操作で開始
                      if (bgm.state === "off") bgm.start();
                      else bgm.stop();
                    }}
                    title="戦闘BGM（ファイルが無ければ鳴りません）"
                  >
                    BGM: {bgm.state === "on" ? "ON" : "OFF"}
                  </Button>
                </div>
              </div>

              {/* Message */}
              <div className="mt-6 rounded-2xl bg-white/80 border border-white/60 p-4 text-slate-800 font-semibold">
                {battle.lastMsg ?? "…"}
              </div>
            </div>

            {/* Quiz panel */}
            <div className="p-6 sm:p-8 border-t border-white/50 bg-white/60">
              <div className="flex items-center justify-between gap-3">
                <div className="text-lg font-extrabold text-slate-900">
                  {battle.pref} クイズ
                </div>
                {quiz?.hint && <Pill>ヒント：{quiz.hint}</Pill>}
              </div>

              {quiz ? (
                <>
                  <div className="mt-3 text-xl font-black text-slate-900">Q. {quiz.q}</div>
                  <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {quiz.c.map((choice, idx) => {
                      const label = ["A", "B", "C", "D"][idx];
                      return (
                        <Button
                          key={idx}
                          variant="ghost"
                          className="text-left py-5"
                          onClick={() => answer(idx)}
                          disabled={battle.finished !== null}
                        >
                          <span className="font-black mr-2">{label}.</span>
                          {choice}
                        </Button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="mt-4 rounded-2xl bg-amber-50 border border-amber-200 p-4 text-amber-900">
                  <div className="font-extrabold">この県はクイズ未設定です</div>
                  <div className="mt-1 text-sm">
                    先生が public/data.json の quizzes を入れると、ここに4択が表示されます。
                  </div>
                  <div className="mt-3">
                    <Button onClick={() => answer(0)} variant="primary">
                      （仮）攻撃する
                    </Button>
                  </div>
                </div>
              )}

              <div className="mt-6 flex items-center justify-between">
                <div className="text-xs text-slate-600">
                  ※ 正解でダメージ / 不正解で反撃。倒すと図鑑に登録！
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Result
  if (scene === "result" && battle) {
    const win = battle.finished === "win";
    return (
      <div className={`${rootBg} p-6 flex items-center justify-center`}>
        <div className="w-full max-w-xl rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 p-6">
          <Header />
          <div className="mt-6 text-center">
            <div className={`text-5xl font-black ${win ? "text-emerald-700" : "text-rose-700"}`}>
              {win ? "勝利！" : "敗北…"}
            </div>
            <div className="mt-3 text-slate-800 font-semibold">
              {win
                ? `${battle.enemy.name} を図鑑に登録しました。`
                : `${battle.enemy.name} にやられてしまった… もう一度挑戦しよう！`}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-3">
            <Button variant="primary" onClick={goMap}>
              マップへ
            </Button>
            <Button onClick={goDex}>図鑑へ</Button>
            <Button
              onClick={() => {
                // もう一度
                bgm.stop();
                startBattle(battle.pref);
              }}
            >
              もう一度
            </Button>
          </div>

          <div className="mt-6 text-xs text-slate-600">
            ※ 倒した瞬間にモンスターは白黒化（グレースケール）します。
          </div>
        </div>
      </div>
    );
  }

  // Dex
  if (scene === "dex") {
    return (
      <div className={`${rootBg} p-6`}>
        <div className="mx-auto max-w-5xl">
          <Header
            right={
              <>
                <Pill>GET {Object.keys(dex).length}/{prefs.length}</Pill>
                <Button onClick={() => setScene("map")}>マップ</Button>
                <Button onClick={() => setScene("title")}>タイトル</Button>
              </>
            }
          />
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {prefs.map((p) => {
              const m = data!.monsters[p];
              const captured = !!dex[p];
              return (
                <div
                  key={p}
                  className={`rounded-3xl p-5 shadow-xl shadow-black/10 border ${
                    captured ? "bg-white/80 border-white/60" : "bg-white/55 border-white/40"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-lg font-extrabold text-slate-900">{p}</div>
                    <Pill>{captured ? "GET" : "未登録"}</Pill>
                  </div>

                  <div className="mt-3 rounded-2xl bg-white/70 p-3 border border-white/50">
                    <div className="text-sm font-black text-slate-900">{m.name}</div>
                    <div className="mt-1 text-xs text-slate-600">属性：{m.species || "未設定"} / 難易度：{m.difficulty}</div>
                  </div>

                  <div className="mt-4 flex items-center justify-center">
                    <img
                      src={m.image}
                      alt={m.name}
                      className={`max-h-[150px] w-auto object-contain ${captured ? "" : "grayscale opacity-60"}`}
                      style={{
                        filter: captured
                          ? "drop-shadow(0 14px 24px rgba(0,0,0,0.12))"
                          : "grayscale(1) drop-shadow(0 14px 24px rgba(0,0,0,0.08))",
                        background: "transparent",
                      }}
                    />
                  </div>

                  <div className="mt-4 rounded-2xl bg-white/70 border border-white/50 p-4 text-sm text-slate-800 leading-relaxed">
                    <div className="text-xs font-bold text-slate-600 mb-1">図鑑説明</div>
                    <div className={`${captured ? "" : "blur-[1px]"}`}>{m.desc || "（説明文未設定）"}</div>
                    {!captured && (
                      <div className="mt-2 text-xs text-slate-500">
                        ※ 未登録のため一部ぼかし表示
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="primary"
                      onClick={() => {
                        const ok = window.confirm(`${p}（${m.name}）と戦いますか？`);
                        if (ok) startBattle(p);
                      }}
                    >
                      戦う
                    </Button>
                    <Button
                      onClick={() => {
                        alert(
                          `クイズ数：${(m.quizzes ?? []).length}\n\n先生が public/data.json に quizzes を入れると増えます。`
                        );
                      }}
                    >
                      情報
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-8 text-center text-xs text-slate-600">
            図鑑のGET状況は「この端末だけ」に保存されます（生徒の達成感用）。
          </div>
        </div>
      </div>
    );
  }

  // Fallback
  return (
    <div className={`${rootBg} p-6 flex items-center justify-center`}>
      <div className="rounded-3xl bg-white/70 backdrop-blur shadow-xl shadow-black/10 p-6">
        <div className="font-extrabold text-slate-900">画面が見つかりません</div>
        <div className="mt-3">
          <Button variant="primary" onClick={() => setScene("title")}>
            タイトルへ
          </Button>
        </div>
      </div>
    </div>
  );
}
