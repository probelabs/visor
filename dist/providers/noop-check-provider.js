"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoopCheckProvider = void 0;
const check_provider_interface_1 = require("./check-provider.interface");
/**
 * No-operation check provider that doesn't perform any analysis.
 *
 * This provider is designed for command orchestration - it allows creating
 * checks that exist purely to trigger other checks through dependencies.
 *
 * Example use case: A "/review" command that triggers multiple analysis checks
 * without performing any analysis itself.
 */
class NoopCheckProvider extends check_provider_interface_1.CheckProvider {
    getName() {
        return 'noop';
    }
    getDescription() {
        return 'No-operation provider for command orchestration and dependency triggering';
    }
    async validateConfig(config) {
        if (!config || typeof config !== 'object') {
            return false;
        }
        const cfg = config;
        // Type must be 'noop'
        if (cfg.type !== 'noop') {
            return false;
        }
        return true;
    }
    async execute(_prInfo, _config, _dependencyResults, _sessionInfo) {
        // Noop provider doesn't perform any analysis
        // It exists purely for command orchestration and dependency triggering
        return {
            issues: [],
            suggestions: [],
        };
    }
    getSupportedConfigKeys() {
        return ['type', 'command', 'depends_on', 'on', 'if', 'group'];
    }
    async isAvailable() {
        // Noop provider is always available
        return true;
    }
    getRequirements() {
        return [
            'No external dependencies required',
            'Used for command orchestration and dependency triggering',
        ];
    }
}
exports.NoopCheckProvider = NoopCheckProvider;
//# sourceMappingURL=noop-check-provider.js.map