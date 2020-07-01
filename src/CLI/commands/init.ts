import ts from "byots";
import { exec } from "child_process";
import build from "CLI/commands/build";
import { CLIError } from "CLI/errors/CLIError";
import fs from "fs-extra";
import kleur from "kleur";
import path from "path";
import prompts from "prompts";
import { LogService } from "Shared/classes/LogService";
import { PACKAGE_ROOT } from "Shared/constants";
import { benchmark } from "Shared/util/benchmark";
import yargs from "yargs";

interface InitOptions {
	yes: boolean;
}

enum InitMode {
	None = "none",
	Game = "game",
	Place = "place",
	Model = "model",
	Plugin = "plugin",
	Package = "package",
}

function cmd(cmdStr: string) {
	return new Promise<string>((resolve, reject) => {
		exec(cmdStr, (error, stdout, stderr) => {
			if (error) {
				reject(error);
			}
			resolve(stdout ? stdout : stderr);
		});
	});
}

const TEMPLATE_DIR = path.join(PACKAGE_ROOT, "templates");
const GIT_IGNORE = ["/node_modules", "/out", "/include", "*.tsbuildinfo"];

async function init(argv: yargs.Arguments<InitOptions>, mode: InitMode) {
	const postEmitLogs = new Array<string>();

	const cwd = process.cwd();
	const paths = {
		packageJson: path.join(cwd, "package.json"),
		packageLockJson: path.join(cwd, "package-lock.json"),
		projectJson: path.join(cwd, "default.project.json"),
		src: path.join(cwd, "src"),
		tsconfig: path.join(cwd, "tsconfig.json"),
		gitignore: path.join(cwd, ".gitignore"),
		eslintrc: path.join(cwd, ".eslintrc.json"),
		settings: path.join(cwd, ".vscode", "settings.json"),
		extensions: path.join(cwd, ".vscode", "extensions.json"),
	};

	const existingPaths = new Array<string>();
	for (const filePath of Object.values(paths)) {
		if (await fs.pathExists(filePath)) {
			const stat = await fs.stat(filePath);
			if (stat.isFile() || (await fs.readdir(filePath)).length > 0) {
				existingPaths.push(path.relative(cwd, filePath));
			}
		}
	}
	if (existingPaths.length > 0) {
		const pathInfo = existingPaths.map(v => `  - ${kleur.yellow(v)}\n`).join("");
		throw new CLIError(`Cannot initialize project, process could overwrite:\n${pathInfo}`);
	}

	if (mode === InitMode.None) {
		mode = (
			await prompts({
				type: "select",
				name: "template",
				message: "Select template",
				choices: [InitMode.Game, InitMode.Model, InitMode.Plugin, InitMode.Package].map(value => ({
					title: value,
					value,
				})),
				initial: 0,
			})
		).template;
	}

	const {
		git,
		eslint,
		prettier,
		vscode,
	}: { git?: boolean; eslint?: boolean; prettier?: boolean; vscode?: boolean } = argv.yes
		? { git: true, eslint: true, prettier: true, vscode: true }
		: await prompts([
				{
					type: "confirm",
					name: "git",
					message: "Configure Git",
					initial: true,
				},
				{
					type: "confirm",
					name: "eslint",
					message: "Configure ESLint",
					initial: true,
				},
				{
					type: (_, values) => values.eslint && "confirm",
					name: "prettier",
					message: "Configure Prettier",
					initial: true,
				},
				{
					type: (_, values) => values.eslint && "confirm",
					name: "vscode",
					message: "Configure VSCode Project Settings",
					initial: true,
				},
		  ]);

	// git init
	await benchmark("Initializing..", async () => {
		if (git) {
			await cmd("git init");
			await fs.outputFile(paths.gitignore, GIT_IGNORE.join("\n") + "\n");
		}

		if (mode === InitMode.Package) {
			await cmd("npm init -y --scope @rbxts");
			const pkgJson = await fs.readJson(paths.packageJson);
			pkgJson.publishConfig = {
				access: "public",
			};
			pkgJson.scripts = {
				prepublishOnly: "rbxtsc",
			};
			pkgJson.main = "out/init.lua";
			pkgJson.types = "out/index.d.ts";
			await fs.outputFile(paths.packageJson, JSON.stringify(pkgJson, null, 2));
		} else {
			await cmd("npm init -y");
		}

		// npm install -D
		const devDependencies = ["@rbxts/types"];
		if (eslint) {
			devDependencies.push(
				"eslint",
				"typescript",
				"@typescript-eslint/eslint-plugin",
				"@typescript-eslint/parser",
				"eslint-plugin-roblox-ts",
			);
			if (prettier) {
				devDependencies.push("prettier", "eslint-config-prettier", "eslint-plugin-prettier");
			}
		}

		await cmd(`npm install --silent -D ${devDependencies.join(" ")}`);

		// create .eslintrc.json
		if (eslint) {
			const eslintConfig = {
				parser: "@typescript-eslint/parser",
				parserOptions: {
					jsx: true,
					useJSXTextNode: true,
					ecmaVersion: 2018,
					sourceType: "module",
					project: "./tsconfig.json",
				},
				plugins: ["@typescript-eslint", "roblox-ts"],
				extends: ["plugin:@typescript-eslint/recommended", "plugin:roblox-ts/recommended"],
				rules: ts.identity<{ [index: string]: object }>({}),
			};

			if (prettier) {
				eslintConfig.plugins.push("prettier");
				eslintConfig.extends.push("prettier/@typescript-eslint", "plugin:prettier/recommended");
				eslintConfig.rules["prettier/prettier"] = [
					"warn",
					{
						semi: true,
						trailingComma: "all",
						singleQuote: false,
						printWidth: 120,
						tabWidth: 4,
						useTabs: true,
					},
				];
			}

			await fs.outputFile(paths.eslintrc, JSON.stringify(eslintConfig, undefined, "\t"));
		}

		if (vscode) {
			const settings = {
				"[typescript]": {
					"editor.defaultFormatter": "dbaeumer.vscode-eslint",
					"editor.formatOnSave": true,
				},
				"eslint.run": "onType",
				"eslint.enable": true,
			};
			await fs.outputFile(paths.settings, JSON.stringify(settings, undefined, "\t"));

			const extensions = {
				recommendations: ["dbaeumer.vscode-eslint"],
			};
			await fs.outputFile(paths.extensions, JSON.stringify(extensions, undefined, "\t"));

			postEmitLogs.push("You may need to reload VSCode for automatic formatting to work.");
		}

		const templateTsConfig = path.join(
			TEMPLATE_DIR,
			`tsconfig-${mode === InitMode.Package ? "package" : "default"}.json`,
		);
		await fs.copy(templateTsConfig, paths.tsconfig);

		await fs.copy(path.join(TEMPLATE_DIR, mode), cwd);
	});

	await benchmark(
		"Building..",
		() => build.handler({ project: ".", verbose: false, watch: false, $0: argv.$0, _: argv._ }) as never,
	);

	for (const line of postEmitLogs) {
		LogService.writeLine(line);
	}
}

const GAME_DESCRIPTION = "Generate a Roblox place";
const MODEL_DESCRIPTION = "Generate a Roblox model";
const PLUGIN_DESCRIPTION = "Generate a Roblox Studio plugin";
const PACKAGE_DESCRIPTION = "Generate a roblox-ts npm package";

/**
 * Defines behavior of `rbxtsc init` command.
 */
export = ts.identity<yargs.CommandModule<{}, InitOptions>>({
	command: "init",
	describe: "Create a project from a template",
	builder: () =>
		yargs
			.option("yes", {
				alias: "y",
				boolean: true,
				default: false,
				describe: "recommended options",
			})
			.command([InitMode.Game, InitMode.Place], GAME_DESCRIPTION, {}, argv => init(argv as never, InitMode.Game))
			.command(InitMode.Model, MODEL_DESCRIPTION, {}, argv => init(argv as never, InitMode.Model))
			.command(InitMode.Plugin, PLUGIN_DESCRIPTION, {}, argv => init(argv as never, InitMode.Plugin))
			.command(InitMode.Package, PACKAGE_DESCRIPTION, {}, argv => init(argv as never, InitMode.Package)),
	handler: argv => init(argv, InitMode.None),
});
