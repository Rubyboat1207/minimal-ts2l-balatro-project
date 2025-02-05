import { Project } from "ts-morph";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const luaDir = path.resolve(import.meta.dirname, "build");
const packageJson = JSON.parse(
    (await fs.readFile(path.resolve(import.meta.dirname, "package.json"))).toString("utf-8")
);
let deploymentDir;

if(process.platform === "win32") {
    deploymentDir = path.resolve(process.env.APPDATA || "", "Balatro", "Mods", packageJson.name);
}else if(process.platform === "darwin") {
    deploymentDir = path.resolve(process.env.HOME || "", "Library", "Application Support", "Balatro", "Mods", packageJson.name);
}

const project = new Project({
    tsConfigFilePath: path.resolve(import.meta.dirname, "tsconfig.json"),
});

interface LovelyPatchData {
    target: string;
    pattern: string;
    position: string;
    type: string;
    matchIndent: boolean;
    locals: string[];
    payloadPrefix?: string;
    payloadSuffix?: string;
}

async function processFiles() {
    let patchToml = '[manifest]\nversion = "1.0.0"';

    const sourceFiles = project.getSourceFiles("src/**/*.ts");
    for (const sourceFile of sourceFiles) {
        sourceFile.getFunctions().forEach(fn => {
            const jsDocs = fn.getJsDocs();
                jsDocs.forEach(doc => {


                    const lovelyPatchData: LovelyPatchData = {
                        target: '',
                        pattern: '',
                        position: '',
                        type: '',
                        matchIndent: true,
                        locals: []
                    };
                    doc.getTags().forEach(tag => {
                        if(tag.getTagName() === 'lovelyTarget') {
                            lovelyPatchData.target = tag.getCommentText() || '';
                        }
                        if(tag.getTagName() === 'lovelyPattern') {
                            lovelyPatchData.pattern = tag.getCommentText() || '';
                        }
                        if(tag.getTagName() === 'lovelyPosition') {
                            lovelyPatchData.position = tag.getCommentText() || '';
                        }
                        if(tag.getTagName() === 'lovelyType') {
                            lovelyPatchData.type = tag.getCommentText() || '';
                        }
                        if(tag.getTagName() === 'lovelyMatchIndent') {
                            lovelyPatchData.matchIndent = tag.getCommentText() === 'true' ? true : false;
                        }
                        if(tag.getTagName() === 'lovelyCaptureLocal') {
                            lovelyPatchData.locals.push(tag.getCommentText() || '');
                        }
                        if(tag.getTagName() === 'lovelyPayloadPrefix') {
                            lovelyPatchData.payloadPrefix = tag.getCommentText() || '';
                            if (lovelyPatchData.payloadPrefix?.startsWith('"') && lovelyPatchData.payloadPrefix?.endsWith('"')) {
                                lovelyPatchData.payloadPrefix = lovelyPatchData.payloadPrefix.slice(1, -1);
                            }
                        }
                        if(tag.getTagName() === 'lovelyPayloadSuffix') {
                            lovelyPatchData.payloadSuffix = tag.getCommentText() || '';
                        }
                    })

                    if(lovelyPatchData.type != '') {
                        patchToml += '\n\n[[patches]]'
                        patchToml += `\n[patches.${lovelyPatchData.type}]`;
                        patchToml += `\ntarget = "${lovelyPatchData.target}"`;
                        patchToml += `\npattern = "${lovelyPatchData.pattern}"`;
                        patchToml += `\nposition = "${lovelyPatchData.position}"`;
                        patchToml += '\nmatch_indent = true';
                        patchToml += `\npayload = """${lovelyPatchData.payloadPrefix || ''}${fn.getName()}(${lovelyPatchData.locals.join(', ')})${lovelyPatchData.payloadSuffix || ''}"""\n`;
                    }
                });
        });
    }

    return patchToml;
}

async function clearDirectory(dir) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                await fs.rm(entryPath, { recursive: true, force: true });
            } else {
                await fs.unlink(entryPath);
            }
        }
    } catch (err) {
        console.error(`Error clearing directory: ${err.message}`);
    }
}

await clearDirectory(deploymentDir);

const patchToml = await processFiles();

const lovelyDir = path.resolve(deploymentDir, "lovely");
try {
    await fs.mkdir(lovelyDir, { recursive: true });
} catch (e) {
    console.error("Failed to create lovely directory:", e);
}

const srcDir = path.resolve(deploymentDir, "src");
try {
    await fs.mkdir(srcDir, { recursive: true });
} catch (e) {
    console.error("Failed to create src directory:", e);
}

await fs.writeFile(path.resolve(lovelyDir, "patches.toml"), patchToml);


await fs.writeFile(
    path.resolve(deploymentDir, `${packageJson.name}.json`),
    JSON.stringify(
        {
            id: packageJson.name,
            name: packageJson.displayName,
            author: Array.isArray(packageJson.author) ? packageJson.author : [packageJson.author],
            description: packageJson.description,
            prefix: packageJson.name.replace(/-/g, "_"),
            version: packageJson.version,
            dependencies: packageJson.smod_deps,
            main_file: packageJson.main.replace(/\.(ts|js)$/, ".lua"),
        },
        null,
        2
    )
);

async function copyDirectory(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await copyDirectory(srcPath, destPath);
        } else {
            await fs.copyFile(srcPath, destPath);
        }
    }
}

await copyDirectory(luaDir, deploymentDir);

const execPromise = promisify(exec);

const extraLuaDir = path.resolve(import.meta.dirname, "extra_lua");

let lua_files_to_include: string[] = [];

try {
    const extraLuaFiles = await fs.readdir(extraLuaDir);

    for (const file of extraLuaFiles) {
        const filePath = path.join(extraLuaDir, file);
        const stat = await fs.stat(filePath);

        if (stat.isFile() && file.endsWith(".ts") && !file.endsWith(".d.ts")) {
            try {
                // read file
                const compileToString = (await fs.readFile(filePath)).toString('utf-8').startsWith('// $love2d-compile-to-string$ //');

                const { stdout, stderr } = await execPromise(`npx tstl -p ${path.resolve(extraLuaDir, 'tsconfig.json')}`);
                if (stdout) console.log(`stdout for ${file}:`, stdout);
                if (stderr) console.error(`stderr for ${file}:`, stderr);

                await new Promise(resolve => setTimeout(resolve, 500));

                const lf = file.replace(/\.ts$/, ".lua");
                const luaFilePath = path.resolve(extraLuaDir, lf);
                const luaDeployPath = path.resolve(deploymentDir, 'extra_lua', lf);

                if (compileToString) {
                    await fs.writeFile(luaFilePath,
                        `${packageJson.name.replace(/-/g, "_").toUpperCase()}_${file.replace('.ts', '').toUpperCase()}_CODE_STR = [=[\n` +
                        `${(await fs.readFile(luaFilePath)).toString('utf-8')}` +
                        `\n]=]\n`
                    );
                }

                const extraLuaDeployDir = path.resolve(deploymentDir, 'extra_lua');
                await fs.mkdir(extraLuaDeployDir, { recursive: true });

                await fs.copyFile(luaFilePath, luaDeployPath);
                lua_files_to_include.push(lf);
                await fs.rm(luaFilePath);
            } catch (error) {
                console.error(`Error executing command for ${file}:`, error);
            }
        }
    }
}catch { }

if(lua_files_to_include.length > 0) {
    await fs.writeFile(path.resolve(lovelyDir, 'extra_lua.toml'), `[manifest]\nversion = "1.0.0"\n\n${
        lua_files_to_include.map(f => `[[patches]]\n[patches.copy]\ntarget="main.lua"\nsources=["extra_lua/${f}"]\nposition="append"\n`).join('\n')
    }`)
}

console.log("Patch metadata and JSON written successfully.");