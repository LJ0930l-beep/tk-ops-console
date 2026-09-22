/**
 * 一键发布到 GitHub：node scripts/publish-github.mjs [--repo tk-ops-console] [--public]
 *
 * 前提：这台机器上先跑过 `gh auth login`（凭证只留在本机 git-credential 里，本脚本不读取也不打印）。
 * 脚本做四件事，任何一步不满足就明确退出、不猜：
 *  1. 确认已登录，并拿到账号名；
 *  2. 推送前扫一遍**已跟踪文件**里有没有该被拦下来的东西（.env、私钥、token 命名的文件、超大文件）；
 *  3. 仓库不存在就按 private/public 建，存在就直接用；
 *  4. 加 remote origin 并推送 master，最后打印仓库与 Actions 地址。
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const repoFlag = argv.indexOf('--repo');
const REPO = repoFlag >= 0 ? argv[repoFlag + 1] : 'tk-ops-console';
const VISIBILITY = argv.includes('--public') ? 'public' : 'private';

const git = (args, opts = {}) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
const gh = (args, opts = {}) => spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8', ...opts });
const die = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// 推送前的最后一道闸：只看会被推上去的东西（已跟踪文件），不扫 node_modules。
// 先做本地体检再碰网络：没登录时也能把这条检查跑完。
const tracked = (git(['ls-files']).stdout ?? '').trim().split('\n').filter(Boolean);
const SUSPECT = /(^|\/)\.env$|(^|\/)\.env\.|id_rsa|\.pem$|\.key$|\.p12$|node_modules\/|(^|\/)secrets?\.(json|ya?ml|ts)$/i;
const suspects = tracked.filter((f) => SUSPECT.test(f));
const oversize = tracked.filter((f) => {
  try {
    return statSync(path.join(ROOT, f)).size > 45 * 1024 * 1024;
  } catch {
    return false;
  }
});
if (suspects.length || oversize.length) {
  console.error('✗ 这些东西不该进远端仓库，先确认再推：');
  for (const f of suspects) console.error(`   可疑文件  ${f}`);
  for (const f of oversize) console.error(`   超过 45MB ${f}`);
  console.error('  确认没问题就加 --force 重跑（或先 git rm --cached 掉它们）');
  if (!argv.includes('--force')) process.exit(1);
  console.log('  · 已带 --force，继续');
}
console.log(`已跟踪文件 ${tracked.length} 个，未发现凭证类文件与超大文件`);

const auth = gh(['auth', 'status']);
if (auth.status !== 0) {
  die('gh 未登录。先在终端执行：gh auth login（选 GitHub.com → HTTPS → Login with a browser），完成后重跑本脚本');
}
const who = gh(['api', 'user', '--jq', '.login']);
if (who.status !== 0 || !who.stdout?.trim()) die(`拿不到 GitHub 账号：${who.stderr?.trim() ?? '未知错误'}`);
const OWNER = who.stdout.trim();
console.log(`已登录：${OWNER} · 目标仓库：${OWNER}/${REPO}（${VISIBILITY}）`);

const exists = gh(['repo', 'view', `${OWNER}/${REPO}`, '--json', 'name']);
if (exists.status !== 0) {
  const created = gh(['repo', 'create', REPO, '--source', '.', '--remote', 'origin', '--push', `--${VISIBILITY}`, '--description', 'TikTok Shop 运营后台（订单/商品/达人/内容/广告/财务/库存 + 规则引擎与行动中心）']);
  if (created.status !== 0) die(`建仓库失败：${(created.stderr || created.stdout || '').trim()}`);
  console.log(`✓ 已创建 ${VISIBILITY} 仓库并推送`);
} else {
  const url = `https://github.com/${OWNER}/${REPO}.git`;
  const hasRemote = git(['remote', 'get-url', 'origin']).status === 0;
  if (hasRemote) git(['remote', 'set-url', 'origin', url]);
  else git(['remote', 'add', 'origin', url]);
  const pushed = git(['push', '-u', 'origin', 'master'], { stdio: 'inherit' });
  if (pushed.status !== 0) die('推送失败（可能是分支保护或凭证范围不够），把上面的报错贴出来');
  console.log('✓ 已推送到既有仓库');
}
console.log(`\n仓库    https://github.com/${OWNER}/${REPO}`);
console.log(`Actions https://github.com/${OWNER}/${REPO}/actions —— 首次会跑 gates（lint/test/build/smoke）与 e2e（Chromium 59 例）`);
