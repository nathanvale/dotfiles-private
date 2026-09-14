'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const { getDomain } = require('tldts');

function siteFromUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
		return null;
	}

	const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
	const ipHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (net.isIP(ipHost) !== 0 || !host.includes('.')) {
		return `${parsed.protocol}//${host}`;
	}

	const domain = getDomain(host, { allowPrivateDomains: true });
	return domain === null ? null : `${parsed.protocol}//${domain.toLowerCase()}`;
}

module.exports = { siteFromUrl };

if (require.main === module) {
	const fields = fs.readFileSync(0, 'utf8').split('\0');
	if (fields.at(-1) === '') fields.pop();
	for (const value of fields) {
		const site = siteFromUrl(value);
		const hash = site === null ? '' : crypto.createHash('sha256').update(site).digest('hex');
		process.stdout.write(`${hash}\0`);
	}
}
