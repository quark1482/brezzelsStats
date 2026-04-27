const https      = require('https');
const ProxyAgent = require('https-proxy-agent');

const requestAgent   = 'Mozilla/5.0';
const requestTimeout = 30000; // In milliseconds (default: 30 sec).

const appServer = 'app.brezzels.com';
const apiServer = 'api.brezzels.com';

const emitCopy = process.emit;

process.emit = function (name) {
    if ('warning' === name) {
        return false;
    }
    else {
        return emitCopy.apply(this, arguments);
    }
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let fetch;

async function bunzAPIRequest(config, operationName = '', variables = {}, query = '') {
    const ret   = {
        code    : 0,
        status  : false,
        message : '',
        json    : {}
    };
    const method  = 'POST';
    const headers = {};
    const payload = {
        operationName,
        variables,
        query
    };
    if (config.session.token) {
        headers['Authorization'] = `Bearer ${config.session.token}`;
    }
    const res = await bunzBaseRequest(method, payload, {}, headers, config.uagent, config.proxy, config.cooldown);
    if (!res.status) {
        ret.code    = res.code;
        ret.message = res.message;
    }
    else {
        if (res.contents) {
            ret.json = JSON.parse(res.contents);
        }
        if (Array.isArray(ret.json.errors) && ret.json.errors.length) {
            ret.message = ret.json.errors[0].message;
        }
        else {
            ret.status = true;
        }
    }
    return ret;
}

async function bunzBaseRequest(method, payload, cookies, headers, uagent, proxy, pause) {
    const ret       = {
        code        : 0,
        status      : false,
        message     : '',
        cookies     : '',
        contents    : {}
    };
    const url       = `https://${apiServer}/graphql`;
    const ctype     = 'application/json';
    const body      = payload ? JSON.stringify(payload) : '';
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(
        function() {
            abortCtrl.abort();
            clearTimeout(timeoutId);
        },
        requestTimeout
    );
    const exOptions = {
        signal: abortCtrl.signal
    };
    if (proxy) {
        let p;
        if (typeof(proxy) === 'function') {
            p = proxy();
            if (p instanceof Promise) {
                p = await p;
            }
        }
        else {
            p = proxy;
        }
        if (p) {
            exOptions.agent = new ProxyAgent.HttpsProxyAgent(p);
            exOptions.agent.keepAlive = true;
        }
    }
    if (!exOptions.agent) {
        exOptions.agent = new https.Agent({ keepAlive: true });
    }
    const options = {
        ...exOptions,
        method,
        headers : {
            'User-Agent'   : uagent || requestAgent,
            'Content-Type' : ctype,
            'Origin'       : `https://${appServer}`,
            'Referer'      : `https://${appServer}/`,
            ...headers
        }
    };
    if (cookies) {
        options.headers.Cookie = cookies;
    }
    if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        options.body = body;
    }
    try {
        fetch = fetch || (await import('node-fetch')).default;
        const res = await fetch(url, options);
        ret.code  = res.status;
        if (![200].includes(ret.code)) {
            ret.message = `Unexpected response code: ${ret.code}`;
        }
        else if (!res.headers.get('Content-Type').startsWith(ctype)) {
            ret.message = `Unexpected content type: ${res.headers.get('Content-Type')}`;
        }
        else {
            ret.contents = await res.text();
            ret.cookies  = (res.headers.raw()['set-cookie'] || []).map(
                function (c) {
                    return c.split(';')[0];
                }
            ).join('; ');
            ret.status   = true;
        }
    }
    catch (err) {
        if ('AbortError' === err.name) {
            err.message = 'The operation timed out';
        }
        else if ('FetchError' === err.name) {
            const m = err.message.match(/\s+reason:\s*(.*)/i);
            if (Array.isArray(m) && m.length > 1) {
                err.message = m[1];
            }
        }
        ret.message = err.message;
    }
    finally {
        clearTimeout(timeoutId);
        await new Promise(
            function(resolve) {
                setTimeout(resolve, pause * 1000);
            }
        );
        return ret;
    }
}

exports.bunzGetBalance = async function (config) {
    const ret   = {
        code    : 0,
        status  : false,
        message : '',
        balance : {}
    };
    const vars  = {};
    const query = 'query BalanceInfoQuery { balanceInfo { estimatedPayout { amount currency } ' +
                  'currentPayout { amount currency } } }';
    const r     = await bunzAPIRequest(config, 'BalanceInfoQuery', vars, query);
    if (!r.status) {
        ret.code    = r.code;
        ret.message = r.message;
        return ret;
    }
    const error = r.json?.data?.balanceInfo?.message;
    if (error) {
        ret.message = error;
        return ret;
    }
    ret.balance   = {
        estimated : r.json?.data?.balanceInfo?.estimatedPayout || undefined,
        current   : r.json?.data?.balanceInfo?.currentPayout   || undefined
    };
    ret.status    = true;
    return ret;
};

exports.bunzGetEarnings = async function (config, dateFrom, pageSize = 6) {
    const ret      = {
        code       : 0,
        status     : false,
        message    : '',
        earnings   : []
    };
    const date1st  = dateFrom || new Date(0);
    const vars     = {
        filter     : {
            positiveEarnings : true
        },
        pagination : {
            limit  : pageSize
        }
    };
    const query    = 'query CreatorEarningsQuery($filter: CreatorSharingsFilterInput, $pagination: CursorInput) { ' +
                     'creatorEarnings(pagination: $pagination, filter: $filter) { paginationInfo { hasNextPage ' +
                     'endCursor startCursor } totalCount edges { node { id buyer { id username } billingType ' +
                     'earningType settleDate sharingCalculationAmount { value currency } } } } }';
    while (true) {
        const r = await bunzAPIRequest(config, 'CreatorEarningsQuery', vars, query);
        if (!r.status) {
            ret.code    = r.code;
            ret.message = r.message;
            break;
        }
        const error = r.json?.data?.creatorEarnings?.message;
        if (error) {
            ret.message = error;
            break;
        }
        const info  = r.json?.data?.creatorEarnings?.paginationInfo || {};
        const edges = r.json?.data?.creatorEarnings?.edges          || [];
        for (const e of edges) {
            const dateExec = new Date(e?.node?.settleDate);
            if (!isNaN(dateExec) && dateExec < date1st) {
                info.hasNextPage = false;
                break;
            }
            ret.earnings.push(e.node);
        }
        if (!info.hasNextPage) {
            ret.status = true;
            break;
        }
        vars.pagination.cursor = info.endCursor;
    }
    return ret;
};

exports.bunzLogin = async function (config, identifier, password) {
    const ret   = {
        code    : 0,
        status  : false,
        message : '',
        session : {}
    };
    const vars  = {
        email   : identifier,
        password
    };
    const query = 'mutation Login($email: String!, $password: String!) { ' +
                  'login(email: $email, password: $password) { ... on LoginResult { ' +
                  'user { id username email avatar { src(baseSize: w640) { url } } ' +
                  'currency firstEarningDate stats { posts likes subscribers } roles } ' +
                  'authToken { token expiresAt } } ... on Restricted { message } } }';
    const r     = await bunzAPIRequest(config, 'Login', vars, query);
    if (!r.status) {
        ret.code    = r.code;
        ret.message = r.message;
        return ret;
    }
    const error = r.json?.data?.login?.message;
    if (error) {
        ret.message = error;
        return ret;
    }
    const user  = r.json?.data?.login?.user             || {};
    const token = r.json?.data?.login?.authToken?.token || '';
    if (!user.id || !user.username || !user.email) {
        ret.message = 'Incomplete user info in Login response';
        return ret;
    }
    if (!token) {
        ret.message = 'Authorization token not found in Login response';
        return ret;
    }
    ret.session.user  = user;
    ret.session.token = token;
    ret.status        = true;
    return ret;
};

exports.bunzLogout = async function (config) {
    const ret   = {
        code    : 0,
        status  : false,
        message : ''
    };
    const vars  = {};
    const query = 'mutation Logout { logout }';
    const r     = await bunzAPIRequest(config, 'Logout', vars, query);
    if (!r.status) {
        ret.code    = r.code;
        ret.message = r.message;
        return ret;
    }
    const error = r.json?.data?.logout?.message;
    if (error) {
        ret.message = error;
        return ret;
    }
    ret.status  = r.json?.data?.logout || false;
    return ret;
};

exports.bunzRefreshToken = async function (config) {
    const ret   = {
        status  : false,
        message : '',
        token   : ''
    };
    const vars  = {};
    const query = 'mutation GetRefreshToken { refreshAuthToken { ... on AuthTokenInfo { ' +
                  'token expiresAt } ... on ErrorMessage { message } } }';
    const r     = await bunzAPIRequest(config, 'GetRefreshToken', vars, query);
    if (!r.status) {
        ret.code    = r.code;
        ret.message = r.message;
        return ret;
    }
    const error = r.json?.data?.refreshAuthToken?.message;
    if (error) {
        ret.message = error;
        return ret;
    }
    ret.token  = r.json?.data?.refreshAuthToken?.token;
    ret.status = true;
    return ret;
};