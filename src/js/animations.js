/**
 * Give a animate.css class to a given element (https://animate.style/)
 * @param {text} [element] - jQuery Object to animate
 * @param {text} [animation] - animation name to apply
 */
export function animateCSS($element, animation, prefix = "animate__") {
    return new Promise((resolve) => {
        const animationName = `${prefix}${animation}`;
        const hasAnimationClass = $element.hasClass(`${prefix}animated`);
        
        $element.addClass(`${prefix}animated ${animationName}`);

        function handleAnimationEnd(event) {
            // Remove the classes from the jQuery object
            event.stopPropagation();
            $element.removeClass(`${animationName}`);
            if (!hasAnimationClass) $element.removeClass(`${prefix}animated`);
            resolve("Animation ended");
        }

        // Use the on() method to attach the event handler
        $element.on("animationend", handleAnimationEnd);
    });
}

/**
 * Draw an explosion at given coordinated
 * @param {number} [x] - horizontal coordinates in pixel
 * @param {number} [y] - vertical coordinates in pixel
 */
export function explode(x, y, startAngle, endAngle) {
    const colors = ["rgba(255, 255, 255, 0.3)"];
    const bubbles = 30;
    const r = (a, b, c) => parseFloat((Math.random() * ((a || 1) - (b || 0)) + (b || 0)).toFixed(c || 0));
    let particles = [];
    let ratio = window.devicePixelRatio;
    let c = document.createElement("canvas");
    let ctx = c.getContext("2d");

    c.style.position = "absolute";
    c.style.left = `${x - 100}px`;
    c.style.top = `${y - 100}px`;
    c.style.pointerEvents = "none";
    c.style.width = `${200}px`;
    c.style.height = `${200}px`;
    c.style.zIndex = 100;
    c.width = 200 * ratio;
    c.height = 200 * ratio;
    document.body.appendChild(c);

    for (let i = 0; i < bubbles; i++) {
        particles.push({
            x: c.width / 2,
            y: c.height / 2,
            radius: r(5, 20),
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: r(startAngle, endAngle, true),
            speed: r(0.5,1.5),
            friction: 0.98,
            opacity: r(0.9, 0.9, true),
            yVel: 0,
            gravity: 0
        });
    }

    render(particles, ctx, c.width, c.height);
    setTimeout(() => document.body.removeChild(c), 200);
}


/**
 * Draw an explosion at given coordinated
 * @param {number} [particles] - Array of particles generated via explode()
 * @param {number} [ctx] - canvas
 * @param {number} [width] - canvas width
 * @param {number} [height] - canvas height
 * @returns {object} canvas
 */
function render(particles, ctx, width, height) {
    requestAnimationFrame(() => render(particles, ctx, width, height));
    ctx.clearRect(0, 0, width, height);

    particles.forEach((p) => {
        p.x += p.speed * Math.cos(p.rotation * Math.PI / 180);
        p.y += p.speed * Math.sin(p.rotation * Math.PI / 180);

        p.opacity -= 0.01;
        p.speed *= p.friction;
        p.radius *= p.friction;
        p.yVel += p.gravity;
        p.y += p.yVel;

        if (p.opacity < 0 || p.radius < 0) return;

        ctx.beginPath();
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;
        ctx.arc(p.x, p.y, p.radius, 0, 2 * Math.PI, false);
        ctx.fill();
    });

    return ctx;
}


/**
 * Count the number an element shows up or down to a new value
 * @param {number|string} goal - the new value
 * @param {number} duration - in ms
 * @param {string} destination - id of the element
 * @param {function(number): string} [format] - HTML of a value, on the way and at the end; without it the values on
 *     the way have as many decimals as the goal (none or one) and the goal itself is shown at the end
 */
export function animateCalc(goal, duration, destination, format) {
    const element = $(`#${destination}`);
    // The value shown now, read from the text (the markup of a format aside): 0 when it is no number ("xxx")
    const start = Number(element.text()) || 0;
    const end = Number(goal);
    const increment = Math.abs(end - start) / (duration / 16);
    const render = format ?? ((value) => value.toFixed(Number.isInteger(end) ? 0 : 1));

    function updateCount(current) {
        element.html(render(current));

        // Determine the animation direction
        if ((start < end && current < end) || (start > end && current > end)) {
            requestAnimationFrame(() => updateCount(start < end ? current + increment : current - increment));
        } else {
            element.html(format ? format(end) : goal);
        }
    }

    updateCount(start);
}