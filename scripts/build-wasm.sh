#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${BUILD_ROOT:-${repo_root}/build}"
source_root="${build_root}/source"
deps_root="${build_root}/wasm-deps"
free_kill_source="${source_root}/FreeKill"
core_source="${source_root}/freekill-core"
wasm_build="${build_root}/wasm"

free_kill_revision="37f8c1248d491f5fbc7a07f1bc53724191e44497"
core_revision="c19441690711b73ffb427b3e7974ec7e92e33bea"
lua_version="5.4.8"
sqlite_year="2024"
sqlite_archive_version="3460100"
openssl_version="3.3.4"

: "${QT_WASM_ROOT:?Set QT_WASM_ROOT to the Qt 6.8 multi-threaded WebAssembly kit}"
: "${QT_HOST_PATH:?Set QT_HOST_PATH to the matching Qt 6.8 desktop host kit}"

for command in git node cmake ninja emcc emar emranlib emmake make perl curl tar unzip; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Missing required command: ${command}" >&2
    exit 1
  fi
done

if ! emcc --version | head -n 1 | grep -q "3\.1\.56"; then
  echo "Qt 6.8 requires Emscripten 3.1.56. Activate that emsdk first." >&2
  exit 1
fi

mkdir -p "${source_root}" "${deps_root}/src" "${deps_root}/install"

clone_revision() {
  local url="$1"
  local revision="$2"
  local destination="$3"
  if [[ ! -d "${destination}/.git" ]]; then
    git clone --filter=blob:none --no-checkout "${url}" "${destination}"
    git -C "${destination}" checkout --detach "${revision}"
  fi
  local actual
  actual="$(git -C "${destination}" rev-parse HEAD)"
  if [[ "${actual}" != "${revision}" ]]; then
    echo "${destination} is at ${actual}; expected ${revision}." >&2
    exit 1
  fi
}

clone_revision "https://github.com/Qsgs-Fans/FreeKill.git" \
  "${free_kill_revision}" "${free_kill_source}"
clone_revision "https://github.com/Qsgs-Fans/freekill-core.git" \
  "${core_revision}" "${core_source}"

if [[ ! -f "${free_kill_source}/freekill-web-build.json" ]]; then
  node "${repo_root}/scripts/prepare-upstream.mjs" \
    --free-kill "${free_kill_source}" \
    --core "${core_source}"
fi

if [[ -n "${EXTRA_PACKAGES_DIR:-}" ]]; then
  if [[ ! -d "${EXTRA_PACKAGES_DIR}" ]]; then
    echo "EXTRA_PACKAGES_DIR does not exist: ${EXTRA_PACKAGES_DIR}" >&2
    exit 1
  fi
  (cd "${EXTRA_PACKAGES_DIR}" && tar --exclude='.git' -cf - .) | \
    (cd "${free_kill_source}/packages" && tar -xf -)
  if [[ -d "${EXTRA_PACKAGES_DIR}/freekill-core" ]]; then
    for core_directory in Fk lua; do
      if [[ -d "${EXTRA_PACKAGES_DIR}/freekill-core/${core_directory}" ]]; then
        rm -rf "${free_kill_source:?}/${core_directory}"
        cp -R "${EXTRA_PACKAGES_DIR}/freekill-core/${core_directory}" \
          "${free_kill_source}/${core_directory}"
      fi
    done
  fi
fi

download() {
  local url="$1"
  local output="$2"
  if [[ ! -f "${output}" ]]; then
    curl --fail --location --retry 3 --output "${output}" "${url}"
  fi
}

lua_prefix="${deps_root}/install/lua"
if [[ ! -f "${lua_prefix}/lib/liblua.a" ]]; then
  lua_archive="${deps_root}/src/lua-${lua_version}.tar.gz"
  download "https://www.lua.org/ftp/lua-${lua_version}.tar.gz" "${lua_archive}"
  tar -xf "${lua_archive}" -C "${deps_root}/src"
  emmake make -C "${deps_root}/src/lua-${lua_version}/src" \
    CC=emcc AR="emar rcu" RANLIB=emranlib \
    MYCFLAGS="-O3 -fPIC" generic
  mkdir -p "${lua_prefix}/include" "${lua_prefix}/lib"
  cp "${deps_root}/src/lua-${lua_version}/src/"*.h "${lua_prefix}/include/"
  cp "${deps_root}/src/lua-${lua_version}/src/liblua.a" "${lua_prefix}/lib/"
fi

sqlite_prefix="${deps_root}/install/sqlite"
if [[ ! -f "${sqlite_prefix}/lib/libsqlite3.a" ]]; then
  sqlite_archive="${deps_root}/src/sqlite-amalgamation-${sqlite_archive_version}.zip"
  download \
    "https://www.sqlite.org/${sqlite_year}/sqlite-amalgamation-${sqlite_archive_version}.zip" \
    "${sqlite_archive}"
  unzip -q -o "${sqlite_archive}" -d "${deps_root}/src"
  sqlite_source="${deps_root}/src/sqlite-amalgamation-${sqlite_archive_version}"
  mkdir -p "${sqlite_prefix}/include" "${sqlite_prefix}/lib"
  emcc -O3 -fPIC -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION \
    -c "${sqlite_source}/sqlite3.c" -o "${sqlite_source}/sqlite3.o"
  emar rcs "${sqlite_prefix}/lib/libsqlite3.a" "${sqlite_source}/sqlite3.o"
  cp "${sqlite_source}/sqlite3.h" "${sqlite_source}/sqlite3ext.h" \
    "${sqlite_prefix}/include/"
fi

openssl_prefix="${deps_root}/install/openssl"
if [[ ! -f "${openssl_prefix}/lib/libcrypto.a" ]]; then
  openssl_archive="${deps_root}/src/openssl-${openssl_version}.tar.gz"
  download \
    "https://github.com/openssl/openssl/releases/download/openssl-${openssl_version}/openssl-${openssl_version}.tar.gz" \
    "${openssl_archive}"
  tar -xf "${openssl_archive}" -C "${deps_root}/src"
  pushd "${deps_root}/src/openssl-${openssl_version}" >/dev/null
  CC=emcc AR=emar RANLIB=emranlib perl ./Configure linux-generic32 \
    no-shared no-asm no-tests no-threads no-dso no-ui-console no-afalgeng \
    --prefix="${openssl_prefix}" --openssldir="${openssl_prefix}/ssl" --libdir=lib
  emmake make -j"${BUILD_JOBS:-4}" build_libs
  emmake make install_dev
  popd >/dev/null
fi

"${QT_WASM_ROOT}/bin/qt-cmake" \
  -S "${free_kill_source}" \
  -B "${wasm_build}" \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DQT_HOST_PATH="${QT_HOST_PATH}" \
  -DLUA_INCLUDE_DIR="${lua_prefix}/include" \
  -DLUA_LIBRARY="${lua_prefix}/lib/liblua.a" \
  -DSQLite3_INCLUDE_DIR="${sqlite_prefix}/include" \
  -DSQLite3_LIBRARY="${sqlite_prefix}/lib/libsqlite3.a" \
  -DOPENSSL_ROOT_DIR="${openssl_prefix}" \
  -DOPENSSL_USE_STATIC_LIBS=TRUE

cmake --build "${wasm_build}" --parallel "${BUILD_JOBS:-4}"
BUILD_DIR="${wasm_build}" OUTPUT_DIR="${repo_root}/dist" \
  node "${repo_root}/scripts/package-web.mjs"

echo "FreeKill Web is ready in ${repo_root}/dist"
