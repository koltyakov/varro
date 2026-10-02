export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => {
      image.src = '';
      reject(new Error('Timed out decoding the image'));
    }, 10_000);
    image.addEventListener(
      'load',
      () => {
        clearTimeout(timeout);
        resolve(image);
      },
      { once: true }
    );
    image.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('Could not decode the image'));
      },
      { once: true }
    );
    image.src = url;
  });
}
