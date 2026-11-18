/**
 * 共享的客户端测试替身：把 verify-modelrow-scroll.js 与 verify-relay-settings.js
 * 中实质重复的 React/DOM/vm 加载骨架与 DOM 树查询工具集中于此。
 * 只做无行为差异的搬移：各测试自己的 reactStub / fakeWindow 仍由测试自行组装。
 */
const vm = require('vm');
const assert = require('assert');

/** 归一化 className（props 缺失也安全）。 */
const classOf = (node) => (node.props !== null && node.props !== undefined && typeof node.props.className === 'string' ? node.props.className : '');
const hasClass = (node, name) => classOf(node).split(' ').indexOf(name) !== -1;

function findAll(node, pred) {
	const out = [];
	(function step(one) {
		if (one === null || one === undefined || one === true || one === false) return;
		if (Array.isArray(one)) { one.forEach(step); return; }
		if (typeof one !== 'object') return;
		if (pred(one)) out.push(one);
		(one.children || []).forEach(step);
	})(node);
	return out;
}

function textOf(node) {
	const out = [];
	(function step(one) {
		if (typeof one === 'string' || typeof one === 'number') { out.push(String(one)); return; }
		if (one === null || one === undefined || one === false || one === true) return;
		if (Array.isArray(one)) { one.forEach(step); return; }
		if (typeof one !== 'object') return;
		(one.children || []).forEach(step);
	})(node);
	return out.join('');
}

/** 文档替身：记录 document 级 click 监听（「点别处」逻辑用）。 */
function makeFakeDocument() {
	const docClicks = [];
	const document = {
		documentElement: { classList: { add() {}, remove() {} } },
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {}, className: '' }),
		body: {}, head: { appendChild() {} },
		addEventListener: (type, fn) => { if (type === 'click' && docClicks.indexOf(fn) === -1) docClicks.push(fn); },
		removeEventListener: (type, fn) => {
			const at = docClicks.indexOf(fn);
			if (at !== -1) docClicks.splice(at, 1);
		}
	};
	return { document: document, docClicks: docClicks };
}

/** 在 vm 沙箱里加载插桩后的 client.js，并取回 __test 导出。 */
function runPlugin(source, reactStub, fakeWindow, fakeDocument, reactDom) {
	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };
	const sandbox = {
		window: fakeWindow,
		document: fakeDocument,
		MutationObserver: class { observe() {} disconnect() {} },
		react: reactStub,
		console: console, Promise: Promise, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array,
		Number: Number, String: String, Boolean: Boolean, Symbol: Symbol, Set: Set, Map: Map, Error: Error,
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		requestAnimationFrame: (fn) => { fn(); return 0; },
		cancelAnimationFrame: () => {}
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'client.js' });
	assert.ok(captured !== null && captured.factory !== undefined, '插件工厂没被捕获');
	const api = captured.factory((name) => {
		if (name === 'react') return reactStub;
		if (name === 'react-dom') {
			if (reactDom !== null && reactDom !== undefined) return reactDom;
			throw new Error('no react-dom');
		}
		throw new Error('unexpected require: ' + name);
	}).__test;
	assert.ok(api !== undefined, '__test 插桩导出没拿到');
	return api;
}

module.exports = { findAll, hasClass, classOf, textOf, makeFakeDocument, runPlugin };
