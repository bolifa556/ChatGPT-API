#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

#ifndef CHATGPT_ENTRY_MODE
#define CHATGPT_ENTRY_MODE "apionly"
#endif

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
    char **arguments = calloc((size_t)argc + 4, sizeof(char *));
    if (!arguments) return 1;
    arguments[0] = node;
    arguments[1] = script;
    arguments[2] = "--entry";
    arguments[3] = CHATGPT_ENTRY_MODE;
    for (int i = 1; i < argc; ++i) arguments[i + 3] = argv[i];
    execve(node, arguments, environ);
    perror("Cannot start the bundled Node runtime");
    free(arguments);
    return 1;
}
