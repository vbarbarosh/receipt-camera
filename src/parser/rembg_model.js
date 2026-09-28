function rembg_model()
{
    return process.env.REMBG_MODEL || 'u2net';
}

module.exports = rembg_model;
