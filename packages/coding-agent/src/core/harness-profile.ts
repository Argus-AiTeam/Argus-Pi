export function getHarnessProfile(): "argus" | "stock" {
	const profile = process.env.PI_HARNESS_PROFILE || "argus";
	if (profile !== "argus" && profile !== "stock") {
		throw new Error(`Unknown PI_HARNESS_PROFILE: ${profile}. Expected stock or argus.`);
	}
	return profile;
}
