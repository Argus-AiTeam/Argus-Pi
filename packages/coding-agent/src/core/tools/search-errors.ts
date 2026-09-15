import { StringDecoder } from "node:string_decoder";

const MAX_ERROR_BYTES = 4096;

/** Retain a small stderr prefix while draining the child, even for one enormous line. */
export class SearchErrors {
	private readonly prefix = Buffer.alloc(MAX_ERROR_BYTES);
	private retained = 0;
	private total = 0;

	append(chunk: Buffer): void {
		this.total += chunk.length;
		this.retained += chunk.copy(this.prefix, this.retained, 0, MAX_ERROR_BYTES - this.retained);
	}

	message(fallback: string): string {
		const truncated = this.total > this.retained;
		const decoder = new StringDecoder("utf8");
		const prefix = decoder.write(this.prefix.subarray(0, this.retained));
		const message = (prefix + (truncated ? "" : decoder.end())).trim() || fallback;
		return truncated
			? `${message}\n\n[Search incomplete. stderr truncated: first ${this.retained} of ${this.total} bytes. Narrow the search path before retrying.]`
			: message;
	}
}
