import { Bindings } from '../util/types';

export async function sendUserNotification(
	bindings: Bindings,
	id: string,
	title: string,
	description: string,
	link?: string,
	type: string = 'info',
	source: string = 'cloud'
) {
	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/users/${id}/notifications`;
	const body = {
		title,
		description,
		link,
		type,
		source
	};

	const res = fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify(body)
	});

	return res;
}
