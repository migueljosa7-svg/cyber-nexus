import * as THREE from 'three';
import type { GameContext, HackMode, HackTarget } from '../context';
import { UPGRADE_INFO, type ItemId, type UpgradeId } from '../player/player';
import { Minigame } from '../ui/minigame';
import type { Vehicle } from '../world/traffic';

/** Max distance for /hack, /override and /interrogate. */
const RANGE = 14;
/** Radius of /scan. */
const SCAN_RADIUS = 46;
const COST: Record<'scan' | HackMode, number> = { scan: 5, hack: 20, override: 35, interrogate: 15 };

const COMMANDS = ['help', 'scan', 'hack', 'override', 'interrogate', 'talk', 'status', 'missions', 'accept', 'abort', 'upgrade', 'shop', 'use', 'ram', 'achievements', 'daily', 'clear', 'exit'];

/**
 * Deep hacking: a retro-futurist command console. Commands work on anything scannable near the player
 * (pedestrians, vehicles, public kiosks, gates, cameras, mission cores) and gate their effect behind a timed
 * decryption minigame. RAM is the resource: it regenerates slowly.
 */
export class HackingSystem {
  private minigame: Minigame;
  private busy = false;
  private promptT = 0;
  private lastScan: HackTarget[] = [];
  private open_ = false;

  constructor(private ctx: GameContext, parent: HTMLElement) {
    this.minigame = new Minigame(parent, ctx.audio);
    ctx.ui.console.onSubmit = (line) => void this.execute(line);
    ctx.ui.console.onClose = () => this.close();
    ctx.ui.console.complete = (prefix) => this.autocomplete(prefix);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  // ───────────────────────────── open / close ─────────────────────────────

  open(): void {
    if (this.open_ || this.ctx.player.dead) return;
    const { engine, input, ui } = this.ctx;
    this.open_ = true;
    input.releaseKeys();
    input.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
    engine.setState('hacking');
    ui.console.open();
    ui.console.print('CYBER-NEXUS OS v7.3 // NEURAL LINK ESTABLISHED', 'sys');
    ui.console.print('Type /help for commands. Tap the chips below on touch devices.', 'dim');
    this.setBaseChips();
    void this.runScan(true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.minigame.abort();
    const { engine, input, ui } = this.ctx;
    ui.console.close();
    ui.setScanMarkers([]);
    input.enabled = true;
    input.releaseKeys();
    if (engine.state === 'hacking') engine.setState('playing');
  }

  private setBaseChips(): void {
    const c = this.ctx.ui.console;
    c.setChips([
      { label: 'SCAN', cmd: '/scan', submit: true },
      { label: 'MISSIONS', cmd: '/missions', submit: true },
      { label: 'STATUS', cmd: '/status', submit: true },
      { label: 'SHOP', cmd: '/shop', submit: true },
      { label: 'UPGRADE', cmd: '/upgrade', submit: true },
      { label: 'HELP', cmd: '/help', submit: true },
      { label: 'EXIT', cmd: '/exit', submit: true },
    ]);
  }

  // ───────────────────────────── per-frame ─────────────────────────────

  /** Shows an interaction prompt when something hackable is within reach. */
  update(dt: number): void {
    if (this.ctx.engine.state !== 'playing') return;
    const { input, ui, player } = this.ctx;
    this.promptT -= dt;
    if (this.promptT <= 0) {
      this.promptT = 0.3;
      const list = this.collect(RANGE);
      const t = list[0];
      ui.setPrompt(t ? (input.isTouch ? 'HACK' : `[F] CONSOLE — ${t.id}`) : null);
    }
    if (input.consume('interact') && !player.dead) this.open();
  }

  // ───────────────────────────── targets ─────────────────────────────

  /** Every hackable thing within `radius` of the player, nearest first. */
  collect(radius: number): HackTarget[] {
    const { player, city, npcs, traffic, missions } = this.ctx;
    const out: HackTarget[] = [];
    const c = player.pos;
    npcs.hackTargets(c, radius, out);
    city.forEachTerminal((t) => {
      const dist = Math.hypot(t.pos.x - c.x, t.pos.z - c.z);
      if (dist > radius || t.hacked) return;
      out.push({
        id: t.id,
        kind: 'terminal',
        label: 'PUBLIC KIOSK',
        pos: t.pos.clone(),
        dist,
        modes: ['hack', 'override'],
        difficulty: 1,
        details: ['CASH CACHE: SEALED', 'ICE: LEVEL 1'],
        apply: (mode) => {
          const credits = 80 + Math.floor(Math.random() * 160) + (mode === 'override' ? 120 : 0);
          city.markTerminalHacked(t);
          player.addCredits(credits);
          player.addXp(mode === 'override' ? 35 : 25);
          this.ctx.state.hacks++;
          this.ctx.engine.events.emit('terminalHacked', { id: t.id });
          return { ok: true, lines: [`>> CACHE UNLOCKED: +${credits} CREDITS`] };
        },
      });
    });
    const cars: Vehicle[] = [];
    traffic.scan(c, radius, cars);
    for (const v of cars) {
      const dist = Math.hypot(v.x - c.x, v.z - c.z);
      out.push({
        id: v.id,
        kind: 'car',
        label: v.fly ? 'HOVER VEHICLE' : 'GROUND VEHICLE',
        pos: new THREE.Vector3(v.x, v.y3 + 0.5, v.z),
        dist,
        modes: ['hack', 'override'],
        difficulty: v.fly ? 2 : 1,
        details: [`SPEED: ${(v.speed * 3.6).toFixed(0)} km/h`, `HEADING: ${v.axis === 0 ? (v.dir > 0 ? 'EAST' : 'WEST') : v.dir > 0 ? 'SOUTH' : 'NORTH'}`],
        apply: (mode) => {
          const secs = mode === 'override' ? 12 : 4;
          traffic.freeze(v, secs);
          const credits = mode === 'override' ? 90 + Math.floor(Math.random() * 120) : 25 + Math.floor(Math.random() * 40);
          player.addCredits(credits);
          player.addXp(mode === 'override' ? 25 : 12);
          this.ctx.state.hacks++;
          return { ok: true, lines: [`>> DRIVE-BY-WIRE SEIZED: vehicle stopped ${secs}s`, `>> WALLET SKIMMED: +${credits} CREDITS`] };
        },
      });
    }
    missions.hackTargets(c, radius, out);
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  // ───────────────────────────── command execution ─────────────────────────────

  private async execute(raw: string): Promise<void> {
    const { ui } = this.ctx;
    const line = raw.trim();
    if (!line) return;
    ui.console.print(`> ${line}`, 'in', true);
    if (this.busy) { ui.console.print('!! SYSTEM BUSY — decryption in progress', 'warn'); return; }
    const parts = line.replace(/^\//, '').split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts[1];
    switch (cmd) {
      case 'help': this.cmdHelp(); break;
      case 'scan': await this.runScan(false); break;
      case 'hack': await this.runHack('hack', arg); break;
      case 'override': await this.runHack('override', arg); break;
      case 'interrogate': await this.runHack('interrogate', arg); break;
      case 'talk': this.cmdTalk(arg); break;
      case 'status': this.cmdStatus(); break;
      case 'missions': this.cmdMissions(); break;
      case 'accept': this.cmdAccept(arg); break;
      case 'abort': this.ctx.missions.abort(); ui.console.print('>> MISSION ABORTED', 'warn'); break;
      case 'upgrade': this.cmdUpgrade(arg); break;
      case 'shop': this.close(); this.ctx.shop.open(); break;
      case 'daily': this.close(); this.ctx.daily.open(); break;
      case 'use': this.cmdUse(arg); break;
      case 'ram': await this.cmdRam(); break;
      case 'achievements': this.cmdAchievements(); break;
      case 'clear': ui.console.clear(); break;
      case 'exit': case 'quit': case 'close': this.close(); break;
      default: ui.console.print(`?? UNKNOWN COMMAND "${cmd}". Type /help`, 'err');
    }
  }

  private cmdHelp(): void {
    const c = this.ctx.ui.console;
    c.print('── COMMANDS ──────────────────────────────', 'sys');
    c.print('/scan                  list targets within 46m  (RAM 5)', 'out');
    c.print('/hack [id]             decrypt & exploit a target (RAM 20)', 'out');
    c.print('/override [id]         full takeover, stronger effect (RAM 35)', 'out');
    c.print('/interrogate [id]      extract intel from a citizen (RAM 15)', 'out');
    c.print('/talk [id]             greet a nearby citizen', 'out');
    c.print('/missions  /accept n   mission board / take a contract', 'out');
    c.print('/abort                 abandon the active mission', 'out');
    c.print('/upgrade [stat]        spend skill points', 'out');
    c.print('/shop  /daily          black market · daily login reward', 'out');
    c.print('/use ram|kit|adr       consume an item (hotkeys 1-3)', 'out');
    c.print('/ram                   watch an ad: instant full RAM', 'out');
    c.print('/achievements          unlocked trophies', 'out');
    c.print('/status  /clear  /exit', 'out');
    c.print('Targets: NPC-xx citizens · CAR/FLY-xx vehicles · TRM-xx kiosks · DOOR · CAM · mission cores', 'dim');
    c.print('Omit [id] to auto-target the nearest valid target in range (14m).', 'dim');
  }

  private async runScan(silentIfEmpty: boolean): Promise<void> {
    const { ui, player } = this.ctx;
    const c = ui.console;
    if (!player.useRam(COST.scan)) { c.print(`!! RAM INSUFFICIENT (need ${COST.scan})`, 'err'); return; }
    this.ctx.audio.glitch();
    const list = this.collect(SCAN_RADIUS);
    this.lastScan = list;
    if (!list.length) {
      if (!silentIfEmpty) c.print('>> NO TARGETS IN RANGE', 'warn');
      else c.print('>> scan complete: nothing in range', 'dim');
      c.setChips(this.baseChipList());
      return;
    }
    c.print(`>> SCAN COMPLETE — ${list.length} signature(s)`, 'ok');
    const shown = list.slice(0, 12);
    for (const t of shown) {
      c.print(`${t.id.padEnd(9)} ${t.label.slice(0, 26).padEnd(26)} ${t.dist.toFixed(0).padStart(3)}m ${t.dist <= RANGE ? '[IN RANGE]' : ''}`, t.dist <= RANGE ? 'ok' : 'out');
    }
    if (list.length > shown.length) c.print(`… +${list.length - shown.length} more`, 'dim');
    ui.setScanMarkers(shown.map((t) => ({ id: t.id, pos: t.pos, label: t.id, color: '#3dffb4', kind: 'scan' as const })));
    const chips = shown.filter((t) => t.dist <= RANGE).slice(0, 5).flatMap((t) => {
      const base = [{ label: `HACK ${t.id}`, cmd: `/hack ${t.id}`, submit: true }];
      if (t.modes.includes('interrogate')) base.push({ label: `INT ${t.id}`, cmd: `/interrogate ${t.id}`, submit: true });
      return base;
    });
    c.setChips([...chips, ...this.baseChipList()]);
  }

  private baseChipList(): Array<{ label: string; cmd: string; submit: boolean }> {
    return [
      { label: 'SCAN', cmd: '/scan', submit: true },
      { label: 'MISSIONS', cmd: '/missions', submit: true },
      { label: 'STATUS', cmd: '/status', submit: true },
      { label: 'EXIT', cmd: '/exit', submit: true },
    ];
  }

  private findTarget(mode: HackMode, arg: string | undefined): HackTarget | string {
    const near = this.collect(SCAN_RADIUS);
    const valid = near.filter((t) => t.modes.includes(mode));
    if (!arg) {
      const t = valid.find((x) => x.dist <= RANGE);
      return t ?? 'NO VALID TARGET WITHIN 14m. Use /scan.';
    }
    const key = arg.toUpperCase();
    let matches = near.filter((t) => t.id === key);
    if (!matches.length) matches = near.filter((t) => t.id.endsWith(key.replace(/^0+/, '')) || t.id.endsWith(key));
    if (!matches.length) return `TARGET "${arg}" NOT FOUND. Use /scan.`;
    if (matches.length > 1) return `AMBIGUOUS ID "${arg}": ${matches.map((m) => m.id).join(', ')}`;
    const t = matches[0];
    if (!t.modes.includes(mode)) return `${t.id} DOES NOT SUPPORT /${mode}`;
    if (t.dist > RANGE) return `${t.id} OUT OF RANGE (${t.dist.toFixed(0)}m > ${RANGE}m)`;
    return t;
  }

  private async runHack(mode: HackMode, arg: string | undefined): Promise<void> {
    const { ui, player, audio } = this.ctx;
    const c = ui.console;
    const found = this.findTarget(mode, arg);
    if (typeof found === 'string') { c.print(`!! ${found}`, 'err'); audio.error(); return; }
    const t = found;
    const cost = COST[mode];
    if (!player.useRam(cost)) { c.print(`!! RAM INSUFFICIENT (need ${cost}, have ${Math.floor(player.ram)})`, 'err'); audio.error(); return; }
    this.busy = true;
    c.print(`>> /${mode} ${t.id} — ${t.label}`, 'sys');
    for (const d of t.details) c.print(`   ${d}`, 'dim');
    c.print('>> breaching ICE ... decrypt the security nodes!', 'warn');
    const diff = 1 + t.difficulty + (mode === 'override' ? 3 : 0) + Math.floor(player.profile.level / 3);
    c.blur();
    const ok = await this.minigame.start(diff);
    this.busy = false;
    c.focus();
    if (!this.open_) return;
    if (ok) {
      audio.success();
      const res = t.apply(mode);
      for (const l of res.lines) c.print(l, res.ok ? 'ok' : 'err');
      c.print(`   RAM ${Math.floor(player.ram)}/${player.maxRam}`, 'dim');
    } else {
      audio.error();
      c.print('!! ICE COUNTERMEASURE TRIGGERED — neural feedback', 'err');
      player.invuln = 0;
      player.takeDamage(8);
      this.ctx.gfx.glitch = 0.8;
      if (t.kind === 'npc') c.print('!! the citizen noticed the intrusion', 'warn');
    }
    void this.runScan(true);
  }

  private cmdTalk(arg: string | undefined): void {
    const { npcs, player, ui } = this.ctx;
    const c = ui.console;
    let n = arg ? npcs.list.find((x) => x.id === arg.toUpperCase() || x.id.endsWith(arg)) ?? null : npcs.nearest(player.pos, 8);
    if (n && Math.hypot(n.rx - player.pos.x, n.rz - player.pos.z) > 10) n = null;
    if (!n) { c.print('!! NO CITIZEN WITHIN 10m', 'err'); return; }
    npcs.talk(n);
    c.print(`>> ${n.name} (${n.job}) nods.`, 'ok');
  }

  private cmdStatus(): void {
    const { player, ui, city, state } = this.ctx;
    const c = ui.console;
    const p = player.profile;
    const d = city.districtAt(player.pos.x, player.pos.z);
    c.print('── RUNNER STATUS ─────────────────────────', 'sys');
    c.print(`LEVEL ${p.level}   XP ${p.xp}/${player.xpToNext}   SKILL PTS ${p.skillPoints}`, 'out');
    c.print(`INTEGRITY ${Math.ceil(player.hp)}/${player.maxHp}   ENERGY ${Math.floor(player.energy)}/${player.maxEnergy}   RAM ${Math.floor(player.ram)}/${player.maxRam}`, 'out');
    c.print(`CREDITS ¢${p.credits}   KILLS ${state.kills}   HACKS ${state.hacks}   CONTRACTS ${state.missionsDone}`, 'out');
    c.print(`LOCATION: DISTRICT ${d.id} · ${d.name}  (${player.pos.x.toFixed(0)}, ${player.pos.z.toFixed(0)})`, 'out');
    const up = p.up;
    c.print(`UPGRADES hull${up.hp} reactor${up.energy} ram${up.ram} servo${up.speed} edge${up.damage}`, 'dim');
  }

  private cmdMissions(): void {
    const { missions, player, ui } = this.ctx;
    const c = ui.console;
    c.print('── CONTRACT BOARD ────────────────────────', 'sys');
    if (missions.active) {
      c.print(`ACTIVE: ${missions.active.title}`, 'ok');
      for (const o of missions.active.objectives) c.print(`  [${o.done ? 'x' : ' '}] ${o.text}${o.optional ? ' (bonus)' : ''}`, o.done ? 'dim' : 'out');
      const hint = missions.hint();
      if (hint) c.print(`  ${hint}`, 'dim');
    }
    if (!missions.offers.length) missions.generateOffers();
    missions.offers.forEach((m, i) => {
      const dist = Math.hypot(m.site.x - player.pos.x, m.site.z - player.pos.z);
      c.print(`[${i + 1}] ${m.title}`, 'out');
      c.print(`    D${m.districtId} ${m.districtName} · ${dist.toFixed(0)}m · threat ${m.difficulty} · ¢${m.rewardCredits} +${m.rewardXp}XP`, 'dim');
    });
    c.print('Use /accept <n> to take a contract.', 'dim');
    c.setChips([
      ...missions.offers.map((_, i) => ({ label: `ACCEPT ${i + 1}`, cmd: `/accept ${i + 1}`, submit: true })),
      ...this.baseChipList(),
    ]);
  }

  private cmdAccept(arg: string | undefined): void {
    const { missions, ui } = this.ctx;
    const c = ui.console;
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > missions.offers.length) { c.print('!! USAGE: /accept <1-' + missions.offers.length + '>', 'err'); return; }
    const m = missions.accept(n - 1);
    if (!m) return;
    c.print(`>> CONTRACT ACCEPTED: ${m.title}`, 'ok');
    c.print(m.briefing, 'out');
    const hint = missions.hint();
    if (hint) c.print(hint, 'dim');
  }

  private cmdUse(arg: string | undefined): void {
    const c = this.ctx.ui.console;
    const map: Record<string, ItemId> = { ram: 'ram', kit: 'kit', adr: 'adrenaline', adrenaline: 'adrenaline' };
    const id = arg ? map[arg.toLowerCase()] : undefined;
    if (!id) { c.print('!! USAGE: /use <ram|kit|adr>', 'err'); return; }
    const msg = this.ctx.player.useItem(id);
    if (msg) { c.print(`>> ${msg}`, 'ok'); this.ctx.audio.pickup(); } else { c.print('!! NOTHING TO USE (empty stock or already full)', 'err'); this.ctx.audio.error(); }
  }

  private async cmdRam(): Promise<void> {
    const { ads, player, ui } = this.ctx;
    const c = ui.console;
    const st = ads.status('ram_refill');
    if (!st.ok) { c.print(st.wait > 0 ? `!! NEXT BROADCAST IN ${st.wait}s` : '!! NO BROADCASTS LEFT THIS SESSION', 'warn'); return; }
    this.busy = true;
    c.blur();
    await ads.request('ram_refill', {
      onAdCompleted: () => { player.ram = player.maxRam; c.print('>> RAM FULLY RECHARGED', 'ok'); },
      onAdFailed: () => c.print('!! BROADCAST NOT COMPLETED — NO REWARD', 'warn'),
    });
    this.busy = false;
    if (this.open_) c.focus();
  }

  private cmdAchievements(): void {
    const c = this.ctx.ui.console;
    const list = this.ctx.progress.list();
    c.print(`── ACHIEVEMENTS ${list.filter((a) => a.done).length}/${list.length} ───────────────`, 'sys');
    for (const a of list) c.print(`[${a.done ? 'x' : ' '}] ${a.name.padEnd(20)} ${a.desc}  (¢${a.reward})`, a.done ? 'ok' : 'dim');
  }

  private cmdUpgrade(arg: string | undefined): void {
    const { player, ui } = this.ctx;
    const c = ui.console;
    const ids = Object.keys(UPGRADE_INFO) as UpgradeId[];
    if (!arg) {
      c.print(`── UPGRADES (skill points: ${player.profile.skillPoints}) ──`, 'sys');
      for (const id of ids) c.print(`${id.padEnd(7)} ${UPGRADE_INFO[id].label.padEnd(16)} lv${player.profile.up[id]}/10  ${UPGRADE_INFO[id].desc}`, 'out');
      c.print('Use /upgrade <hp|energy|ram|speed|damage>', 'dim');
      c.setChips([...ids.map((id) => ({ label: id.toUpperCase(), cmd: `/upgrade ${id}`, submit: true })), ...this.baseChipList()]);
      return;
    }
    const id = ids.find((x) => x === arg.toLowerCase());
    if (!id) { c.print(`!! UNKNOWN STAT "${arg}"`, 'err'); return; }
    if (!player.upgrade(id)) { c.print(player.profile.skillPoints <= 0 ? '!! NO SKILL POINTS' : '!! STAT AT MAX LEVEL', 'err'); this.ctx.audio.error(); return; }
    this.ctx.audio.success();
    c.print(`>> ${UPGRADE_INFO[id].label} → LEVEL ${player.profile.up[id]}   (${player.profile.skillPoints} points left)`, 'ok');
  }

  private autocomplete(prefix: string): string | null {
    const raw = prefix.replace(/^\//, '');
    const parts = raw.split(/\s+/);
    if (parts.length <= 1) {
      const hit = COMMANDS.find((c) => c.startsWith(parts[0].toLowerCase()));
      return hit ? `/${hit} ` : null;
    }
    const last = parts[parts.length - 1].toUpperCase();
    const t = this.lastScan.find((x) => x.id.startsWith(last));
    return t ? `/${parts.slice(0, -1).join(' ')} ${t.id}` : null;
  }
}
