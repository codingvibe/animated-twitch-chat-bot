export default {
  'goku':{
    'getSprite': (sprite, texture) => {
      sprite.texture = texture;
      return sprite;
    },

    'getAnimationDefinition': (sprite, screenHeight, screenWidth) => {
      const animation = [];
      for (let i = 0; i < 10; i++) {
        const position = getNewPosition(sprite, screenHeight, screenWidth);
        animation.push({
          type: "REPOSITION",
          x: position.x,
          y: position.y,
          rotation: position.rotation
        });
        const popInAnimation = getPopInAnimation(position.x, position.y, sprite.height, screenHeight, screenWidth);
        animation.push(popInAnimation.startAnimation);
        animation.push(popInAnimation.endAnimation);
      }
      return animation;
    }
  },
  'vegeta': {
    'getSprite': (sprite, texture) => {
      sprite.texture = texture;
      return sprite;
    },

    'getAnimationDefinition': (sprite, screenHeight, screenWidth) => {
      const pauseTime = Date.now() + 4412;
      const animation = [
        {
          type: "PAUSE",
          stopCondition: (container) => {
            return Date.now() > pauseTime
          }
        }
      ];
      for (let i = 0; i < 7; i++) {
        const position = getNewPosition(sprite, screenHeight, screenWidth);
        animation.push({
          type: "REPOSITION",
          x: position.x,
          y: position.y,
          rotation: position.rotation
        });
        const popInAnimation = getPopInAnimation(position.x, position.y, sprite.height, screenHeight, screenWidth);
        animation.push(popInAnimation.startAnimation);
        animation.push(popInAnimation.endAnimation);
      }
      console.log(animation);
      return animation;
    }
  }
}

function getNewPosition(sprite, screenHeight, screenWidth) {
  let startX = 0;
  let startY = 50;
  let rotation = 0;
  const direction = Math.random();
  if (direction < 0.25) {
    startX = 0;
    startY = Math.floor(Math.random() * (screenHeight - sprite.width*2) + sprite.width);
    rotation = 3.14*0.5;
  } else if (direction >= 0.25 && direction < 0.5) {
    startX = screenWidth;
    startY = Math.floor(Math.random() * (screenHeight - sprite.width*2) + sprite.width);
    rotation = 3.14*1.5;
  } else if (direction >= 0.5 && direction < 0.75) {
    startX = Math.floor(Math.random() * (screenWidth - sprite.width*2) + sprite.width);
    startY = 0;
    rotation = 3.14;
  } else {
    startX = Math.floor(Math.random() * (screenWidth - sprite.width*2) + sprite.width);
    startY = screenHeight;
  }
  return {
    'x': startX,
    'y': startY,
    'rotation': rotation
  }
}

function getPopInAnimation(x, y, height, screenHeight, screenWidth) {
  let startAnimation;
  let endAnimation;
  const stepSize = height/16;
  const horizontal = x <= 0 || x >= screenWidth;
  const startingAt0 = x <= 0 || y <= 0;
  if (horizontal && startingAt0) {
    startAnimation = {
      type: "MOVE_RIGHT",
      stopCondition: (sprite) => {
        return (sprite.x >= sprite.height);
      },
      stepSize: stepSize
    };
    endAnimation = {
      type: "MOVE_LEFT",
      stopCondition: (sprite) => {
        return (sprite.x <= 0);
      },
      stepSize: stepSize
    };
  } else if (horizontal && !startingAt0) {
    startAnimation = {
      type: "MOVE_LEFT",
      stopCondition: (sprite) => {
        return (sprite.x <= (screenWidth - sprite.height));
      },
      stepSize: stepSize
    };
    endAnimation = {
      type: "MOVE_RIGHT",
      stopCondition: (sprite) => {
        return (sprite.x >= screenWidth);
      },
      stepSize: stepSize
    };
  } else if (!horizontal && startingAt0) {
    startAnimation = {
      type: "MOVE_DOWN",
      stopCondition: (sprite) => {
        return (sprite.y >= sprite.height);
      },
      stepSize: stepSize
    };
    endAnimation = {
      type: "MOVE_UP",
      stopCondition: (sprite) => {
        return (sprite.y <= 0);
      },
      stepSize: stepSize
    };
  } else {
    startAnimation = {
      type: "MOVE_UP",
      stopCondition: (sprite) => {
        return (sprite.y <= (screenHeight - sprite.height));
      },
      stepSize: stepSize
    };
    endAnimation = {
      type: "MOVE_DOWN",
      stopCondition: (sprite) => {
        return (sprite.y >= screenHeight);
      },
      stepSize: stepSize
    };
  }
  return {
    startAnimation,
    endAnimation
  }
}