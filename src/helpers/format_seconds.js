function format_seconds(ms)
{
    return `${(ms/1000).toFixed(3)}s`;
}

module.exports = format_seconds;
