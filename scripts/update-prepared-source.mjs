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

const trackedPreloadDependencies = `  file(GLOB_RECURSE FK_WEB_PRELOAD_FILES CONFIGURE_DEPENDS
    LIST_DIRECTORIES false
    "\${PROJECT_SOURCE_DIR}/audio/*"
    "\${PROJECT_SOURCE_DIR}/fonts/*"
    "\${PROJECT_SOURCE_DIR}/image/*"
    "\${PROJECT_SOURCE_DIR}/lua/*"
    "\${PROJECT_SOURCE_DIR}/Fk/*"
    "\${PROJECT_SOURCE_DIR}/client/*"
    "\${FK_WEB_PACKAGES_DIR}/*"
  )
  set_property(TARGET FreeKill APPEND PROPERTY LINK_DEPENDS \${FK_WEB_PRELOAD_FILES})
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

const initialPageAnchor = `  Component.onCompleted: {
`;

const legacyWebInitialPageLoader = `  function loadInitialPage() {
    const component = Qt.createComponent("Fk.Pages.Common", "Init");
    if (!component) {
      console.error("Unable to create the initial page component.");
      return;
    }

    const wasLoading = component.status === Component.Loading;
    const finishLoading = () => {
      if (component.status === Component.Ready) {
        if (wasLoading) component.statusChanged.disconnect(finishLoading);
        mainStack.push(component);
        if (Config.firstRun) {
          Config.firstRun = false;
          mainStack.push(Qt.createComponent("Tutorial.qml").createObject());
        }
      } else if (component.status === Component.Error) {
        if (wasLoading) component.statusChanged.disconnect(finishLoading);
        console.error("Unable to load the initial page: " + component.errorString());
      }
    };

    if (wasLoading) {
      component.statusChanged.connect(finishLoading);
    } else {
      finishLoading();
    }
  }

  Component.onCompleted: {
`;

const webInitialPageLoader = `  function pushLoadedComponent(component, label, onReady) {
    if (!component) {
      console.error("Unable to create " + label + " component.");
      return;
    }

    let waiting = component.status === Component.Loading;
    const finishLoading = () => {
      if (component.status === Component.Ready) {
        if (waiting) {
          component.statusChanged.disconnect(finishLoading);
          waiting = false;
        }
        const page = component.createObject(mainStack);
        if (!page) {
          console.error("Unable to instantiate " + label + ": " + component.errorString());
          return;
        }
        mainStack.push(page);
        if (onReady) onReady();
      } else if (component.status === Component.Error) {
        if (waiting) {
          component.statusChanged.disconnect(finishLoading);
          waiting = false;
        }
        console.error("Unable to load " + label + ": " + component.errorString());
      }
    };

    if (waiting) {
      component.statusChanged.connect(finishLoading);
    } else {
      finishLoading();
    }
  }

  function loadInitialPage() {
    const component = Qt.createComponent(
      "Fk.Pages.Common", "Init", Component.Asynchronous, root);
    pushLoadedComponent(component, "the initial page", () => {
      if (Config.firstRun) {
        Config.firstRun = false;
        const tutorial = Qt.createComponent(
          "Tutorial.qml", Component.Asynchronous, root);
        pushLoadedComponent(tutorial, "the tutorial");
      }
    });
  }

  Component.onCompleted: {
`;

const immediateInitialPagePush = `    mainStack.push(Qt.createComponent("Fk.Pages.Common", "Init"));
    if (Config.firstRun) {
      Config.firstRun = false;
      mainStack.push(Qt.createComponent("Tutorial.qml").createObject());
    }
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
if (!after.includes("FK_WEB_PRELOAD_FILES")) {
  const count = after.split(splitPreload).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one split preload block in ${cmakePath}, found ${count}`);
  }
  after = after.replace(splitPreload, splitPreload + trackedPreloadDependencies);
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

const rootPagePaths = [
  join(options.freeKill, "Fk", "Base", "RootPage.qml"),
  join(options.freeKill, "packages", "freekill-core", "Fk", "Base", "RootPage.qml"),
];
for (const rootPagePath of rootPagePaths) {
  const rootPageBefore = (await readFile(rootPagePath, "utf8")).replaceAll("\r\n", "\n");
  let rootPageAfter = rootPageBefore;
  if (rootPageAfter.includes(legacyWebInitialPageLoader)) {
    rootPageAfter = rootPageAfter.replace(legacyWebInitialPageLoader, webInitialPageLoader);
  } else if (!rootPageAfter.includes("function loadInitialPage()")) {
    const anchorCount = rootPageAfter.split(initialPageAnchor).length - 1;
    if (anchorCount !== 1) {
      throw new Error(
        `Expected one initial page loader anchor in ${rootPagePath}, found ${anchorCount}`,
      );
    }
    const pushCount = rootPageAfter.split(immediateInitialPagePush).length - 1;
    if (pushCount !== 1) {
      throw new Error(
        `Expected one immediate initial page push in ${rootPagePath}, found ${pushCount}`,
      );
    }
    rootPageAfter = rootPageAfter
      .replace(initialPageAnchor, webInitialPageLoader)
      .replace(immediateInitialPagePush, "    loadInitialPage();\n");
  }
  if (rootPageAfter === rootPageBefore) {
    console.log(`Prepared FreeKill initial page loading is current: ${rootPagePath}`);
  } else {
    await writeFile(rootPagePath, rootPageAfter);
    console.log(`Updated prepared FreeKill initial page loading: ${rootPagePath}`);
  }
}
