import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function argumentsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--free-kill") options.freeKill = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.freeKill) throw new Error("--free-kill is required");
  return options;
}

const oldPreload = `  foreach(resource_dir IN ITEMS audio fonts image lua Fk client packages)
    target_link_options(FreeKill PRIVATE
      "SHELL:--preload-file \\"\${PROJECT_SOURCE_DIR}/\${resource_dir}@/\${resource_dir}\\"")
  endforeach()
`;

const splitPreload = `  foreach(resource_dir IN ITEMS audio fonts image lua Fk client)
    target_link_options(FreeKill PRIVATE
      "SHELL:--preload-file \\"\${PROJECT_SOURCE_DIR}/\${resource_dir}@/\${resource_dir}\\"")
  endforeach()
  set(FK_WEB_PACKAGES_DIR "\${PROJECT_SOURCE_DIR}/packages" CACHE PATH
    "Package directory embedded in the WebAssembly client")
  target_link_options(FreeKill PRIVATE
    "SHELL:--preload-file \\"\${FK_WEB_PACKAGES_DIR}@/packages\\"")
`;

const oldRuntimeExports = `  set_target_properties(FreeKill PROPERTIES QT_WASM_MAXIMUM_MEMORY 2147483648)
  target_link_options(FreeKill PRIVATE
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s FORCE_FILESYSTEM=1"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=FS,IDBFS,addRunDependency,removeRunDependency"
  )
`;

const mergedRuntimeExports = `  set_target_properties(FreeKill PROPERTIES
    QT_WASM_MAXIMUM_MEMORY 2147483648
    QT_WASM_EXTRA_EXPORTED_METHODS "addRunDependency,removeRunDependency"
  )
  target_link_options(FreeKill PRIVATE
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s FORCE_FILESYSTEM=1"
    "SHELL:-lidbfs.js"
  )
`;

const invalidRuntimeExports = `  set_target_properties(FreeKill PROPERTIES
    QT_WASM_MAXIMUM_MEMORY 2147483648
    QT_WASM_EXTRA_EXPORTED_METHODS "IDBFS,addRunDependency,removeRunDependency"
  )
  target_link_options(FreeKill PRIVATE
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s FORCE_FILESYSTEM=1"
  )
`;

const options = argumentsFrom(process.argv.slice(2));
const cmakePath = join(options.freeKill, "src", "CMakeLists.txt");
const before = (await readFile(cmakePath, "utf8")).replaceAll("\r\n", "\n");
let after = before;
if (!after.includes("set(FK_WEB_PACKAGES_DIR")) {
  const count = after.split(oldPreload).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one legacy package preload block in ${cmakePath}, found ${count}`);
  }
  after = after.replace(oldPreload, splitPreload);
}
if (after.includes(invalidRuntimeExports)) {
  after = after.replace(invalidRuntimeExports, mergedRuntimeExports);
} else if (!after.includes("QT_WASM_EXTRA_EXPORTED_METHODS")) {
  const count = after.split(oldRuntimeExports).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one legacy runtime export block in ${cmakePath}, found ${count}`);
  }
  after = after.replace(oldRuntimeExports, mergedRuntimeExports);
}
if (after === before) {
  console.log("Prepared FreeKill source is current.");
} else {
  await writeFile(cmakePath, after);
  console.log("Updated prepared FreeKill source for incremental web media.");
}
