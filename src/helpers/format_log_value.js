// A printable ASCII word without spaces, quotes, backslashes or square
// brackets goes bare; every other string, and any non-string, is JSON.
function format_log_value(value)
{
    if ((typeof value === 'string') && /^[!#-Z^-~]+$/.test(value)) {
        return value;
    }
    return JSON.stringify(value);
}

module.exports = format_log_value;
