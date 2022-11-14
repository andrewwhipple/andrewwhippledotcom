/* global __dirname, process */

let express = require('express');
let app = express();
let fs = require('fs');
let marked = require('marked');
let favicon = require('serve-favicon');
let http = require('http');
var helmet = require('helmet');
let Promise = require('es6-promise').Promise;

Promise.polyfill();

function readFilePromise(fileName) {
    return new Promise(function(resolve, reject){
        fs.readFile(fileName, function(err, content){
            if (err) {
                reject(err);
            }
            resolve(content);
        });
    });
}

let settings = {
    //Info relating to the final, surfaced web site.
    siteConfig: {
        'description': '',
        'navbar': '',
        'metaDescription': '',
        'metaKeywords': '',
        'metaAuthor': '',
        'defaultTitle': ''
    },
    //Info relating to the running of the app code
    appConfig: {
        'lastPulled': null,
        'configTTL': 1800000,
        'port': process.env.AM_PORT || 80,
        'filePath': process.env.AM_FILEPATH || 'default', //This is set in the "setup.sh" script, but on subsequent starts may need to be set in a startup script or hardcoded here. More info in README.
        'cacheMaxAge': 300
    }
};

app.use(favicon(__dirname + '/favicon.ico'));

app.set('views', './views');
app.set('view engine', 'pug');

function loadConfigs() {
    let configs = ['description.md', 'navbar.md', 'app-config.json', 'site-config.json'];

    for (let i = 0; i < configs.length; i++) {
        configs[i] = settings.appConfig.filePath + '/config/' + configs[i];
    }
    configs = configs.map(readFilePromise);

    Promise.all(configs)
        .then(function(files) {
            settings.siteConfig.description = marked(files[0].toString());
            settings.siteConfig.navbar = marked(files[1].toString());

            let appConfigFile = JSON.parse(files[2]);

            settings.appConfig.configTTL = appConfigFile.configTTL || settings.appConfig.configTTL;
            settings.appConfig.cacheMaxAge = appConfigFile.cacheMaxAge || settings.appConfig.cacheMaxAge;
            settings.appConfig.lastPulled = Date.now();

            let siteConfigFile = JSON.parse(files[3]);

            settings.siteConfig.metaDescription = siteConfigFile.metaDescription || settings.siteConfig.metaDescription;
            settings.siteConfig.metaAuthor = siteConfigFile.metaAuthor || settings.siteConfig.metaAuthor;
            settings.siteConfig.metaKeywords = siteConfigFile.metaKeywords || settings.siteConfig.metaKeywords;
            settings.siteConfig.defaultTitle = siteConfigFile.defaultTitle || settings.siteConfig.defaultTitle;

            const now = new Date();

            settings.siteConfig.currentYear = now.getFullYear();
        }).catch(function(err){
            console.log(err);
        });
}

loadConfigs();

app.use(express.static(settings.appConfig.filePath + '/static'));
app.use('/css', express.static(__dirname + '/css'));
app.use('/scripts', express.static(__dirname + '/scripts'));
app.use('/fonts', express.static(__dirname + '/fonts'));

app.use(helmet({
	noCache: false
}));

function configDataIsExpired() {
    return Date.now() - settings.appConfig.lastPulled > settings.appConfig.configTTL;
}

/**
 * Function that, given a response object from an app.get() call, the number of posts to render
 * 	(or null if you want all possible posts) and a substring to search for (again, or null if you
 * 	want all posts) and creates the page for a blogroll and sends the response to the client.
 *
 * @param {*} res: express Response object
 * @param {int} [numPosts] number of posts to render, null to render all posts
 * @param {string} [searchString] string to search the filepath for, typically used for finding all posts in
 * 	a certain year or month (ex: searching for "2016/03")
*/
function getBlogroll(res, numPosts, searchString) {
    fs.readFile(settings.appConfig.filePath + '/blog/postList.json', function(err, content) {
        if (err) {
            console.log(err);

            return;
        }
        let postList = JSON.parse(content);

        //Ordering is by date, most recent first, and reverse alphabetical if multiple on one day.
        postList.posts.sort();
        postList.posts.reverse();

        searchString = searchString || '';
        numPosts = numPosts || postList.posts.length;

        let blogRollPostFiles = [];

        for (let i = 0; i < numPosts; i++) {
            if (i < postList.posts.length && postList.posts[i].toString().indexOf(searchString) !== -1) {
                blogRollPostFiles.push(settings.appConfig.filePath + postList.posts[i] + '.md');
            }
        }
        blogRollPostFiles = blogRollPostFiles.map(readFilePromise);

        let blogRollPosts = [];

        Promise.all(blogRollPostFiles).then(function(posts) {
            for (let j = 0; j < posts.length; j++) {
                let postData = getDataFromMarkdown(posts[j].toString());

                blogRollPosts.push(postData);
            }

            res.set('Cache-Control', 'public, max-age=' + settings.appConfig.cacheMaxAge);
            res.render('index', {
                metaDescription: settings.siteConfig.metaDescription,
                metaKeywords: settings.siteConfig.metaKeywords,
                metaAuthor: settings.siteConfig.metaAuthor,
                title: settings.siteConfig.defaultTitle,
                siteTitle: settings.siteConfig.defaultTitle,
                navbar: settings.siteConfig.navbar,
                description: settings.siteConfig.description,
                readMore: true,
                posts: blogRollPosts,
                copyrightYear: settings.siteConfig.currentYear
            });
        }).catch(function(err) {
            console.log(err);
        });
    });
}

/**
 * Wrapper to read the the Markdown data from a given blog post filename and url path.
 *
 * @param {string} post url slug of a post file (aka the post filename minus `.md`)
 * @param {string} path date-structured URL path to the post file (ex: "2016/01/01")
 * @param {function} callback a callback function that will be called with errors (if any) and the markdown from the
 * 	file, as a string
*/
function getBlogMarkdown(post, path, callback) {
    fs.readFile(settings.appConfig.filePath + '/blog/' + path + post + '.md', function(err, data) {
        if (!err) data = data.toString();
        callback(err, data);
    });
}

/**
 * Wrapper like getBlogMarkdown, but searches the filepaths for pages.
 *
 * @param {string} page url slug of a page file (aka the page filename minus `.md`)
 * @param {function} callback a callback function that will be called with errors (if any) and the markdown from the
 *	file, as a string
*/
function getPageMarkdown(page, callback) {
    fs.readFile(settings.appConfig.filePath + '/page/' + page + '.md', function(err, data) {
        if (!err) data = data.toString();
        callback(err, data);
    });
}

/**
 * Wrapper for pulling formatted content from the markdown retrieved from a post or page file
 *
 * @param {*} markdown a string for the Amelie-formatted markdown pulled from a post or page file
 * @returns {dict} dict containing:
 * 	"metadata": json dict of the metadata pulled from the markdown header
 * 	"content": string of html, converted from the body content of the markdown
 */
function getDataFromMarkdown(markdown) {
    let metadataRaw = markdown.match(/@@:.*:@@/)[0];
    let metadataJSONString = metadataRaw.replace('@@:', '{').replace(':@@', '}');
    let metadata = JSON.parse(metadataJSONString);

    let content = marked(markdown.replace(/@@:.*:@@/, ''));

    return {
        'metadata': metadata,
        'content': content
    };
}

//Route handler for the homepage, responsible for creating the main blogroll
app.get('/', function(req, res) {
    if (configDataIsExpired()) {
        loadConfigs();
    }
    getBlogroll(res, 5, null);
});

//Route handler for the full, infinite scroll blogroll.
app.get('/blogroll', function(req, res) {
    getBlogroll(res, null, null);
});

//Route handler for individual blog post permalinks
app.get('/blog/:year/:month/:day/:post/', function(req, res) {
    let path = '' + req.params.year + '/' + req.params.month + '/' + req.params.day + '/';

    getBlogMarkdown(req.params.post, path, function(err, data) {
        if (err) {
            res.redirect('/404');
        } else {
            let post = getDataFromMarkdown(data);

            res.set('Cache-Control', 'public, max-age=' + settings.appConfig.cacheMaxAge);
            res.render('index', {
                metaDescription: post.metadata.metaDescription || settings.siteConfig.metaDescription,
                metaKeywords: post.metadata.metaKeywords || settings.siteConfig.metaKeywords,
                metaAuthor: post.metadata.metaAuthor || settings.siteConfig.metaAuthor,
                siteTitle: settings.siteConfig.defaultTitle,
                navbar: settings.siteConfig.navbar,
                description: settings.siteConfig.description,
                copyrightYear: settings.siteConfig.currentYear,
                title: post.metadata.title,
                posts: [post]
            });
        }
    });
});

//Route handler for the monthly archive pages. Basically a modified index blogroll page.
app.get('/blog/:year/:month/', function(req, res) {
    let dateString = req.params.year + '/' + req.params.month + '/';

    getBlogroll(res, null, dateString);
});

//Route handler for static pages
app.get('/:page', function(req, res) {
    getPageMarkdown(req.params.page, function(err, data) {
        if (err) {
            res.redirect('/404');
        } else {
            let page = getDataFromMarkdown(data);

            res.set('Cache-Control', 'public, max-age=' + settings.appConfig.cacheMaxAge);
            res.render('index', {
                metaDescription: page.metadata.metaDescription || settings.siteConfig.metaDescription,
                metaKeywords: page.metadata.metaKeywords || settings.siteConfig.metaKeywords,
                metaAuthor: page.metadata.metaAuthor || settings.siteConfig.metaAuthor,
                siteTitle: settings.siteConfig.defaultTitle,
                navbar: settings.siteConfig.navbar,
                description: settings.siteConfig.description,
                copyrightYear: settings.siteConfig.currentYear,
                title: page.metadata.title,
                page: page.content
            });
        }
    });
});

//Implement this eventually
app.get('/kill-cache', function(req, res) {
	res.redirect('/404');
});

//If all else fails! Must be last get handler. A generic 404-er
app.get('/*', function(req, res) {
    res.redirect('/404');
});

http.createServer(app).listen(settings.appConfig.port);
