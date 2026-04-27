const bunzAPI = require('./bunz-api.js');

const defaultCooldown   = 1; // 1 second, after each call of the first parameter of testExec.
const defaultMaxThreads = 2; // 2 threads, available to split API requests using offset & limit.
const defaultMaxLives   = 3; // 3 lives (2 retries), for each call of the first parameter of testExec.
const defaultFactor     = 5; // 5 times the previous delay, as backoff multiplier.

const refreshTime = 900000; // 3600000 = 1 hour; 900000 = 15 minutes.

class BunzWrapper {
    constructor() {
        this.lastError  = '';
        this.lastResult = undefined;
        this.config     = {
            cooldown    : defaultCooldown,
            threads     : defaultMaxThreads,
            lives       : defaultMaxLives,
            factor      : defaultFactor,
            uagent      : '',
            proxy       : ''
        };
        this._clearSession();
    }
    static sleep(ms = 500) {
        return new Promise(
            function(resolve) {
                setTimeout(resolve, ms);
            }
        );
    }
}

module.exports = BunzWrapper;

BunzWrapper.prototype.testExec = async function (F, R, E4Fail = [400, 404]) {
    let lives = this.config.lives; // total tries;
    let delay = 1;                 // max delay: this.config.multiplier^(this.config.lives-1) sec
    await BunzWrapper.sleep(0);
    while (lives) {
        const req = await F();
        this.lastError  = req.message;
        this.lastResult = R && req[R] != undefined ? req[R] : R;
        if (req.status) {
            return req.status;
        }
        else {
            if (E4Fail.includes(req.code)) {
                return req.status;
            }
            lives--;
            if (!lives) {
                return req.status;
            }
        }
        console.log(`bunzAPI error [${req.message}]; lives ${lives}`);
        delay *= this.config.factor;
        await BunzWrapper.sleep(delay * 1000);
    }
};

BunzWrapper.prototype._clearSession = function() {
    this.config.session  = {
        _refIId : 0,
        token   : '',
        user    : {}
    }
};

BunzWrapper.prototype.getBalance = async function () {
    return this.testExec(() => bunzAPI.bunzGetBalance(this.config), 'balance');
};

BunzWrapper.prototype.getEarnings = async function (dateFrom, pageSize) {
    return this.testExec(() => bunzAPI.bunzGetEarnings(this.config, dateFrom, pageSize), 'earnings');
};

BunzWrapper.prototype.login = async function (identifier, password) {
    const ret = await this.testExec(() => bunzAPI.bunzLogin(this.config, identifier, password), 'session');
    if (ret) {
        this.config.session = this.lastResult;
        this.config.session._refIId = setInterval(async () => await this.refreshToken(), refreshTime);
    }
    return ret;
};

BunzWrapper.prototype.logout = async function () {
    const ret = await this.testExec(() => bunzAPI.bunzLogout(this.config));
    if (ret) {
        clearInterval(this.config.session._refIId);
        this._clearSession();
    }
    return ret;
};

BunzWrapper.prototype.refreshToken = async function() {
    const ret = await this.testExec(() => bunzAPI.bunzRefreshToken(this.config), 'token');
    if (ret) {
        this.config.session.token = this.lastResult;
    }
    return ret;
};