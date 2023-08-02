/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	FLOW_CONTROL: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	STORAGE: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;
}

const API_LIMIT_PER_MINUTE = 15;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

		const { pathname } = new URL(request.url);

		if (pathname === '/get') {
			return getImage(request, env, ctx);
		} else if (pathname === '/update') {
			return refresh(request, env, ctx);
		}

		return new Response('', { status: 404 });
	}
};

async function getImage(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
	const ip = request.headers.get('x-forwarded-for') || '127.0.0.1';

	// 访问控制
	const count = parseInt(await env.FLOW_CONTROL.get(ip, { type: 'text' }) || '0');
	if (count > API_LIMIT_PER_MINUTE) {
		return new Response('Rate limit exceeded', { status: 429 });
	}
	await env.FLOW_CONTROL.put(ip, (count + 1).toString(), { expirationTtl: 60 });

	let LIST_CACHE: string[] = await env.FLOW_CONTROL.get('LIST_CACHE', { type: 'json' }) || [];

	if (LIST_CACHE.length === 0) {
		return new Response('Object Not Found', { status: 404 });
	}

	// 返回图片
	const randomObject = LIST_CACHE[Math.floor(Math.random() * LIST_CACHE.length)];

	const object = await env.STORAGE.get(randomObject);

	if (object === null) {
		return new Response('Object Not Found', { status: 404 });
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);

	return new Response(object.body, {
		headers
	});
}

async function refresh(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
	const options = {
		limit: 500,
		include: ['customMetadata', 'httpMetadata']
	};

	const listed = await env.STORAGE.list();
	console.log(listed);

	let truncated = listed.truncated;
	let cursor = listed.truncated ? listed.cursor : undefined;

	while (truncated) {
		const next = await env.STORAGE.list({
			...options,
			cursor: cursor
		});
		listed.objects.push(...next.objects);

		truncated = next.truncated;
		cursor = next.truncated ? next.cursor : undefined;
	}

	await env.FLOW_CONTROL.put('LIST_CACHE', JSON.stringify(listed.objects.map(obj=>obj.key)));

	return new Response(`OK ${listed.objects.length} objects`);

}
