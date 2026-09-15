/**
 * 跑 tests/ 下所有 verify*.js 并汇总结果。
 * 用法：node tools/test.cjs；退出码 0 = 全部通过。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(DIR).filter((name) => /^verify.*\.js$/.test(name)).sort();

let failed = 0;
files.forEach((name) => {
	const run = spawnSync(process.execPath, [path.join(DIR, name)], { encoding: 'utf8' });
	const out = (run.stdout || '').trim().split('\n').filter(Boolean);
	const last = out.length === 0 ? '' : out[out.length - 1];
	if (run.status === 0) {
		console.log('= ' + name.padEnd(24) + last);
		return;
	}
	failed += 1;
	const err = (run.stderr || '').trim().split('\n').filter(Boolean);
	console.log('× ' + name.padEnd(24) + (err.length === 0 ? last : err[0]));
});

console.log('');
console.log(failed === 0 ? files.length + ' 个测试全部通过' : failed + ' / ' + files.length + ' 个失败');
process.exit(failed === 0 ? 0 : 1);
