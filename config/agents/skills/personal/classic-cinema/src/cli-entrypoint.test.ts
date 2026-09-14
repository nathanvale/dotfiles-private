import { describe, expect, spyOn, test } from "bun:test";
import { maybeExitWithHelp, runMain } from "./cli-entrypoint.ts";

describe("classic-cinema CLI entrypoint", () => {
	test.serial("prints help and exits for both help flags", () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const exitCodes: number[] = [];
		const exit = spyOn(process, "exit").mockImplementation((code?: number) => {
			exitCodes.push(code ?? 0);
			return undefined as never;
		});

		try {
			maybeExitWithHelp("-h", "usage");
			maybeExitWithHelp("--help", "usage");

			expect(log).toHaveBeenCalledTimes(2);
			expect(log).toHaveBeenNthCalledWith(1, "usage");
			expect(log).toHaveBeenNthCalledWith(2, "usage");
			expect(exitCodes).toEqual([0, 0]);
			expect(exit).toHaveBeenCalledTimes(2);
		} finally {
			exit.mockRestore();
			log.mockRestore();
		}
	});

	test.serial("does nothing for an ordinary argument", () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const exit = spyOn(process, "exit").mockImplementation(() => undefined as never);

		try {
			maybeExitWithHelp("--movie", "usage");

			expect(log).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
		} finally {
			exit.mockRestore();
			log.mockRestore();
		}
	});

	test.serial("reports a rejected main and exits with code 1", async () => {
		const error = new Error("boom");
		const errorLog = spyOn(console, "error").mockImplementation(() => {});
		const exitCodes: number[] = [];
		const exit = spyOn(process, "exit").mockImplementation((code?: number) => {
			exitCodes.push(code ?? 0);
			return undefined as never;
		});

		try {
			runMain(async () => {
				throw error;
			});
			await Promise.resolve();

			expect(errorLog).toHaveBeenCalledWith("boom");
			expect(exitCodes).toEqual([1]);
			expect(exit).toHaveBeenCalledTimes(1);
		} finally {
			exit.mockRestore();
			errorLog.mockRestore();
		}
	});
});
