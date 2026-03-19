#!/bin/bash
#
# 自动打包脚本
# 从 domain.json 读取配置参数，自动完成构建并输出 IPA
#
# 用法:
#   ./auto_build.sh                      # 默认 release_arm64 配置
#   ./auto_build.sh --config /path/to/domain.json   # 指定外部配置文件
#   ./auto_build.sh --configuration release_universal   # 指定构建配置
#

set -euo pipefail

# ============================================================
# 颜色输出
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ============================================================
# 项目根目录（脚本所在目录）
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ============================================================
# 默认参数
# ============================================================
CONFIGURATION="release_arm64"
DO_CLEAN=false
CACHE_DIR="$HOME/telegram-bazel-cache"
OUTPUT_DIR="$SCRIPT_DIR/build-output"
CONFIG_FILE=""

# ============================================================
# 解析命令行参数
# ============================================================
while [[ $# -gt 0 ]]; do
    case "$1" in
        --configuration)
            CONFIGURATION="$2"
            shift 2
            ;;
        --config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        --cache-dir)
            CACHE_DIR="$2"
            shift 2
            ;;
        --help|-h)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --configuration <config>  构建配置 (默认: release_arm64)"
            echo "                            可选: debug_arm64, debug_sim_arm64, release_sim_arm64,"
            echo "                                  release_arm64, release_universal"
            echo "  --config <path>           指定配置文件路径 (默认: ./domain.json)"
            echo "  -h, --help                显示帮助信息"
            exit 0
            ;;
        *)
            error "未知参数: $1，使用 --help 查看帮助"
            ;;
    esac
done

# ============================================================
# 检查依赖
# ============================================================
check_dependency() {
    if ! command -v "$1" &>/dev/null; then
        error "未找到命令: $1，请先安装"
    fi
}

check_dependency python3
check_dependency git

# ============================================================
# 读取 domain.json 配置
# ============================================================
if [[ -n "$CONFIG_FILE" ]]; then
    if [[ "$CONFIG_FILE" == /* ]]; then
        DOMAIN_JSON="$CONFIG_FILE"
    else
        DOMAIN_JSON="$SCRIPT_DIR/$CONFIG_FILE"
    fi
else
    DOMAIN_JSON="$SCRIPT_DIR/domain.json"
fi
if [[ ! -f "$DOMAIN_JSON" ]]; then
    error "未找到配置文件: $DOMAIN_JSON"
fi

info "读取 domain.json 配置..."

APP_NAME=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('appName', ''))")
OP_KEY=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('opKey', ''))")
ICON_PATH=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('icon', ''))")
LAUNCH_SCREEN=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('LaunchScreen', ''))")
DOMAINS=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); entries=d.get('domain', []); print('\n'.join(e['ip']+':'+str(e['port']) if isinstance(e,dict) else e for e in entries))")
REQUEST_HTTP=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('requestHttp', ''))")
CERT_PATH=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('cert', ''))")
RELEASE_CONFIG_PATH=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('release-configuration', ''))")
CONFIG_VERSION=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(d.get('version', ''))")

info "应用名称:     $APP_NAME"
info "OP Key:       $OP_KEY"
info "图标路径:     $ICON_PATH"
info "启动图路径:   $LAUNCH_SCREEN"
info "请求地址:     $REQUEST_HTTP"
info "证书路径:     $CERT_PATH"
info "发布配置:     $RELEASE_CONFIG_PATH"
info "域名列表:"
echo "$DOMAINS" | while read -r line; do
    info "  - $line"
done

# ============================================================
# 读取 versions.json，若配置文件指定了 version 则更新
# ============================================================
VERSIONS_JSON="$SCRIPT_DIR/versions.json"
if [[ ! -f "$VERSIONS_JSON" ]]; then
    error "未找到 versions.json 文件"
fi

# 如果 domain.json 指定了 version，则更新 versions.json 中的 app 版本
if [[ -n "$CONFIG_VERSION" ]]; then
    info "配置文件指定了 version: $CONFIG_VERSION 更新 versions.json..."
    python3 -c "
import json
path = '$VERSIONS_JSON'
with open(path) as f:
    data = json.load(f)
data['app'] = '$CONFIG_VERSION'
with open(path, 'w') as f:
    json.dump(data, f, indent=4, ensure_ascii=False)
    f.write('\n')
"
    success "versions.json 中 app 版本已更新为: $CONFIG_VERSION"
fi

APP_VERSION=$(python3 -c "import json; d=json.load(open('$VERSIONS_JSON')); print(d.get('app', ''))")
XCODE_VERSION=$(python3 -c "import json; d=json.load(open('$VERSIONS_JSON')); print(d.get('xcode', ''))")
BAZEL_VERSION=$(python3 -c "import json; d=json.load(open('$VERSIONS_JSON')); print(d.get('bazel', '').split(':')[0])")

info "App 版本:     $APP_VERSION"
info "Xcode 版本:   $XCODE_VERSION"
info "Bazel 版本:   $BAZEL_VERSION"

# ============================================================
# 计算 Build Number = build_number_offset + git commit count
# ============================================================
if [[ ! -f "$SCRIPT_DIR/build_number_offset" ]]; then
    error "未找到 build_number_offset 文件"
fi

BUILD_NUMBER_OFFSET=$(cat "$SCRIPT_DIR/build_number_offset" | tr -d '[:space:]')
GIT_COMMIT_COUNT=$(git rev-list --count HEAD)
BUILD_NUMBER=$((BUILD_NUMBER_OFFSET + GIT_COMMIT_COUNT))

info "Build Number Offset: $BUILD_NUMBER_OFFSET"
info "Git Commit Count:    $GIT_COMMIT_COUNT"
info "Build Number:        $BUILD_NUMBER"

# ============================================================
# 解析证书和发布配置路径（支持相对路径）
# ============================================================
resolve_path() {
    local path="$1"
    if [[ "$path" == /* ]]; then
        echo "$path"
    else
        echo "$SCRIPT_DIR/$path"
    fi
}

# 证书文件（mobileprovision）
RESOLVED_CERT_PATH=$(resolve_path "$CERT_PATH")
if [[ ! -f "$RESOLVED_CERT_PATH" ]]; then
    warn "证书文件不存在: $RESOLVED_CERT_PATH"
fi

# 发布配置 JSON（用于 --configurationPath）
RESOLVED_RELEASE_CONFIG=$(resolve_path "$RELEASE_CONFIG_PATH")
if [[ ! -f "$RESOLVED_RELEASE_CONFIG" ]]; then
    warn "发布配置文件不存在: ${RESOLVED_RELEASE_CONFIG}，将使用默认配置"
    RESOLVED_RELEASE_CONFIG="$SCRIPT_DIR/build-system/main-configuration.json"
fi

info "解析后的证书路径:   $RESOLVED_CERT_PATH"
info "解析后的配置路径:   $RESOLVED_RELEASE_CONFIG"

# ============================================================
# 确定 codesigning 路径
# ============================================================
# 优先使用 main-codesigning，如果不存在则用 fake-codesigning
CODESIGNING_PATH="$SCRIPT_DIR/build-system/main-codesigning"
if [[ ! -d "$CODESIGNING_PATH" ]]; then
    warn "main-codesigning 目录不存在，使用 fake-codesigning"
    CODESIGNING_PATH="$SCRIPT_DIR/build-system/fake-codesigning"
fi

# 如果 domain.json 指定了 cert，则将其复制到 codesigning profiles 目录
if [[ -f "$RESOLVED_CERT_PATH" ]]; then
    info "复制证书到 codesigning 目录..."
    cp "$RESOLVED_CERT_PATH" "$CODESIGNING_PATH/profiles/" 2>/dev/null || true
fi

info "Codesigning 路径: $CODESIGNING_PATH"

# ============================================================
# 替换图标和启动图资源
# 将 icon 目录中的所有文件直接覆盖到 Telegram/Telegram-iOS/
# ============================================================
RESOLVED_ICON_PATH=$(resolve_path "$ICON_PATH")
TARGET_IOS_DIR="$SCRIPT_DIR/Telegram/Telegram-iOS"

if [[ -d "$RESOLVED_ICON_PATH" ]]; then
    info "图标源目录: $RESOLVED_ICON_PATH"
    info "开始替换图标资源到 Telegram/Telegram-iOS/ ..."
    cp -Rf "$RESOLVED_ICON_PATH"/* "$TARGET_IOS_DIR"/ 2>/dev/null
    ICON_TOTAL=$(find "$RESOLVED_ICON_PATH" -type f ! -name '.DS_Store' | wc -l | tr -d ' ')
    success "图标替换完成，共覆盖 $ICON_TOTAL 个文件"
else
    warn "图标目录不存在: $RESOLVED_ICON_PATH，跳过图标替换"
fi

# ============================================================
# 替换启动图
# ============================================================
RESOLVED_LAUNCH_SCREEN=$(resolve_path "$LAUNCH_SCREEN")
LAUNCH_IMAGE_DIR="$SCRIPT_DIR/Telegram/Telegram-iOS/DefaultAppIcon.xcassets/default_bg.imageset"

if [[ -f "$RESOLVED_LAUNCH_SCREEN" ]]; then
    info "启动图文件: $RESOLVED_LAUNCH_SCREEN"

    TARGET_LAUNCH_IMG="$LAUNCH_IMAGE_DIR/default_bg.jpg"
    SRC_EXT="${RESOLVED_LAUNCH_SCREEN##*.}"

    if [[ "$SRC_EXT" == "jpg" || "$SRC_EXT" == "jpeg" ]]; then
        cp "$RESOLVED_LAUNCH_SCREEN" "$TARGET_LAUNCH_IMG"
    elif [[ "$SRC_EXT" == "png" ]]; then
        sips -s format jpeg "$RESOLVED_LAUNCH_SCREEN" --out "$TARGET_LAUNCH_IMG" >/dev/null 2>&1
    else
        cp "$RESOLVED_LAUNCH_SCREEN" "$TARGET_LAUNCH_IMG"
    fi

    success "启动图已替换: $(basename "$RESOLVED_LAUNCH_SCREEN") -> default_bg.jpg"
else
    warn "启动图文件不存在: $RESOLVED_LAUNCH_SCREEN，跳过启动图替换"
fi

# ============================================================
# 替换项目源码中的配置参数
# ============================================================
NETWORK_SWIFT="$SCRIPT_DIR/submodules/TelegramCore/Sources/Network/Network.swift"
BUILD_FILE="$SCRIPT_DIR/Telegram/BUILD"

# --- 0. 从 Telegram/BUILD 的 CFBundleDisplayName 读取当前 app 名称，替换为 appName ---
if [[ -n "$APP_NAME" ]]; then
    # 从 BUILD 文件中提取 CFBundleDisplayName 下一行 <string>...</string> 的值
    OLD_APP_NAME=$(sed -n '/<key>CFBundleDisplayName<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$BUILD_FILE" | head -1)
    if [[ -z "$OLD_APP_NAME" ]]; then
        warn "无法从 Telegram/BUILD 中提取 CFBundleDisplayName，跳过名称替换"
    elif [[ "$OLD_APP_NAME" == "$APP_NAME" ]]; then
        info "当前 app 名称已是 '$APP_NAME'，无需替换"
    else
        info "从 Telegram/BUILD 读取到当前名称: '$OLD_APP_NAME'，替换为 '$APP_NAME'..."
        # 在 Telegram/、submodules/ 目录中递归替换
        find "$SCRIPT_DIR/Telegram" "$SCRIPT_DIR/submodules" \
            -type f \( -name '*.swift' -o -name '*.strings' -o -name '*.plist' -o -name 'BUILD' \) \
            -exec grep -l "$OLD_APP_NAME" {} \; | while read -r file; do
            sed -i '' "s/$OLD_APP_NAME/$APP_NAME/g" "$file"
        done
        success "所有 '$OLD_APP_NAME' 已替换为 '$APP_NAME'"
    fi
else
    warn "appName 为空，跳过名称替换"
fi

# --- 1. 替换 Network.swift 中的 requestHttp URL ---
if [[ -n "$REQUEST_HTTP" ]]; then
    info "替换 Network.swift 中的 requestHttp URL..."
    # 匹配 URLRequest(url: URL(string: "...")!) 中的 URL
    sed -i '' 's|URLRequest(url: URL(string: "[^"]*")!)|URLRequest(url: URL(string: "'"$REQUEST_HTTP"'")!)|g' "$NETWORK_SWIFT"
    success "requestHttp URL 已替换为: $REQUEST_HTTP"
else
    warn "requestHttp 为空，跳过 URL 替换"
fi

# --- 2. 替换 BUILD 文件中 com.openinstall.APP_KEY 下方的值 ---
if [[ -n "$OP_KEY" ]]; then
    info "替换 com.openinstall.APP_KEY 的值..."
    # 匹配 <key>com.openinstall.APP_KEY</key> 下一行的 <string>...</string>
    sed -i '' '/<key>com\.openinstall\.APP_KEY<\/key>/{
        n
        s|<string>[^<]*</string>|<string>'"$OP_KEY"'</string>|
    }' "$BUILD_FILE"
    success "opKey 已替换为: $OP_KEY"
else
    warn "opKey 为空，跳过 APP_KEY 替换"
fi

# --- 3. 替换 Network.swift 中的 initAddressList（域名列表）---
DOMAIN_COUNT=$(python3 -c "import json; d=json.load(open('$DOMAIN_JSON')); print(len(d.get('domain', [])))")
if [[ "$DOMAIN_COUNT" -gt 0 ]]; then
    info "替换 Network.swift 中的 initAddressList（共 $DOMAIN_COUNT 个域名）..."

    # 使用 python3 生成新的 initAddressList 内容并替换
    DOMAIN_JSON="$DOMAIN_JSON" NETWORK_SWIFT="$NETWORK_SWIFT" python3 << 'PYEOF'
import json
import re
import os

domain_json_path = os.environ.get("DOMAIN_JSON", "domain.json")
network_swift_path = os.environ.get("NETWORK_SWIFT", "")

with open(domain_json_path) as f:
    config = json.load(f)

domains = config.get("domain", [])
if not domains:
    exit(0)

# 解析每个域名，支持 {"ip": ..., "port": ...} 对象格式和旧的 URL 字符串格式
pairs = []
for entry in domains:
    if isinstance(entry, dict):
        # 新格式: {"ip": "192.168.1.1", "port": 1231}
        host = entry.get("ip", "")
        port = int(entry.get("port", 443))
    else:
        # 旧格式: URL 字符串
        url = entry
        cleaned = re.sub(r'^https?://', '', url)
        if ':' in cleaned:
            parts = cleaned.split(':', 1)
            host = parts[0].rstrip('/')
            port_str = parts[1].split('/')[0]
            try:
                port = int(port_str)
            except ValueError:
                port = 443
        else:
            host = cleaned.rstrip('/')
            port = 443
    pairs.append((host, port))

# 生成 Swift 格式的 initAddressList
entries = ', '.join([f'("{host}", {port})' for host, port in pairs])
new_content = f'let initAddressList : [Int: [(String, UInt16)]] = [\n    \n    1:[{entries}]\n]'

# 读取 Network.swift
with open(network_swift_path, 'r') as f:
    content = f.read()

# 用正则替换 initAddressList 定义块
# 匹配从 "let initAddressList" 到闭合的 "]" 
pattern = r'let initAddressList\s*:\s*\[Int:\s*\[\(String,\s*UInt16\)\]\]\s*=\s*\[.*?\n\]'
new_content_lines = new_content
content = re.sub(pattern, new_content_lines, content, flags=re.DOTALL)

with open(network_swift_path, 'w') as f:
    f.write(content)

print(f"initAddressList updated with {len(pairs)} entries")
PYEOF

    success "initAddressList 已更新"
else
    warn "domain 列表为空，跳过 initAddressList 替换"
fi

echo ""

# ============================================================
# 开始构建
# ============================================================
echo ""
echo "============================================================"
info "开始构建 $APP_NAME"
info "配置: $CONFIGURATION"
info "Build Number: $BUILD_NUMBER"
echo "============================================================"
echo ""

# 清理（如果指定 --clean）
if [[ "$DO_CLEAN" == true ]]; then
    info "清理 bazel 缓存..."
    python3 build-system/Make/Make.py \
        --overrideXcodeVersion \
        clean
    success "清理完成"
fi

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# ============================================================
    # 构建 IPA
    # ============================================================
BUILD_START_TIME=$(date +%s)

info "开始构建 IPA..."
python3 build-system/Make/Make.py \
    --overrideXcodeVersion \
    --cacheDir="$CACHE_DIR" \
    build \
    --configurationPath="$RESOLVED_RELEASE_CONFIG" \
    --codesigningInformationPath="$CODESIGNING_PATH" \
    --buildNumber="$BUILD_NUMBER" \
    --configuration="$CONFIGURATION" \
    --outputBuildArtifactsPath="$OUTPUT_DIR"

BUILD_END_TIME=$(date +%s)
BUILD_DURATION=$((BUILD_END_TIME - BUILD_START_TIME))
BUILD_MINUTES=$((BUILD_DURATION / 60))
BUILD_SECONDS=$((BUILD_DURATION % 60))

# ============================================================
# 构建结果
# ============================================================
echo ""
echo "============================================================"
if [[ -f "$OUTPUT_DIR/Telegram.ipa" ]]; then
    IPA_SIZE=$(du -h "$OUTPUT_DIR/Telegram.ipa" | cut -f1)

    # 以应用名重命名 IPA
    FINAL_IPA_NAME="${APP_NAME}_v${APP_VERSION}_${BUILD_NUMBER}.ipa"
    cp "$OUTPUT_DIR/Telegram.ipa" "$OUTPUT_DIR/$FINAL_IPA_NAME"

    success "构建成功！"
    info "应用名称:  $APP_NAME"
    info "版本:      $APP_VERSION"
    info "Build:     $BUILD_NUMBER"
    info "配置:      $CONFIGURATION"
    info "IPA 大小:  $IPA_SIZE"
    info "IPA 路径:  $OUTPUT_DIR/$FINAL_IPA_NAME"
    if [[ -f "$OUTPUT_DIR/Telegram.DSYMs.zip" ]]; then
        DSYM_SIZE=$(du -h "$OUTPUT_DIR/Telegram.DSYMs.zip" | cut -f1)
        info "dSYM 大小: $DSYM_SIZE"
        info "dSYM 路径: $OUTPUT_DIR/Telegram.DSYMs.zip"
    fi
    info "构建耗时:  ${BUILD_MINUTES}分${BUILD_SECONDS}秒"
else
    error "构建失败：未找到 IPA 文件"
fi
echo "============================================================"