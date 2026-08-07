dirs=(
    # "node_modules"
    "dist"
    "stats.html"
    # tauri
    # "src/tauri/target"
    "dist_tauri"
)

for dir in ${dirs[@]}; do
    if [ -e $dir ]; then
        echo "rm -rf $dir"
        rm -rf $dir
    fi
done
