#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
    char executable[8192], resolved[8192], node[8192], script[8192];
    uint32_t capacity = sizeof(executable);
    if (_NSGetExecutablePath(executable, &capacity) != 0 || !realpath(executable, resolved)) {
        perror("Cannot locate chatgpt-apionly.app");
        return 1;
    }
    char *slash = strrchr(resolved, '/');
    if (!slash) return 1;
    *slash = '\0';
    slash = strrchr(resolved, '/');
    if (!slash) return 1;
    *slash = '\0'; /* Contents */
    if (snprintf(node, sizeof(node), "%s/Resources/release/payload/runtime/node", resolved) >= (int)sizeof(node) ||
        snprintf(script, sizeof(script), "%s/Resources/gui.mjs", resolved) >= (int)sizeof(script)) return 1;
    char **arguments = calloc((size_t)argc + 2, sizeof(char *));
    if (!arguments) return 1;
    arguments[0] = node;
    arguments[1] = script;
    for (int i = 1; i < argc; ++i) arguments[i + 1] = argv[i];
    execve(node, arguments, environ);
    perror("Cannot start the bundled Node runtime");
    free(arguments);
    return 1;
}
