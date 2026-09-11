export const READ_RANGE_PATTERN = /^([1-9]\d*)(?:-([1-9]\d*))?$/;

export function parseReadRange(value: string, label: string): [number, number] {
	const match = value.match(READ_RANGE_PATTERN);
	if (!match) {
		throw new Error(`Invalid ${label}: use a positive number or inclusive range, such as '3' or '3-5'.`);
	}
	return [Number(match[1]), Number(match[2] ?? match[1])];
}
