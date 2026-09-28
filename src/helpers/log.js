// One event per line: [group_uid][sender] details. No time field: docker
// stamps every line of the service.
function log(group_uid, sender, details = '')
{
    if (details === '') {
        console.log(`[${group_uid}][${sender}]`);
        return;
    }
    console.log(`[${group_uid}][${sender}] ${details}`);
}

module.exports = log;
